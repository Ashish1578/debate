import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Enhanced logging with structured fields
const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  redact: ['password', 'secret', 'token'],
  formatters: {
    level(label: string) {
      return { level: label };
    }
  },
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  } : undefined
});

// FIXED: Strongly typed branded types
type SocketId = string & { readonly brand: unique symbol };
type RoomId = string & { readonly brand: unique symbol };
type NormalizedTag = string & { readonly brand: unique symbol };

// Core interfaces with proper exports
export interface WaitingUser {
  readonly socketId: SocketId;
  readonly tags: readonly string[];
  readonly normalizedTags: readonly NormalizedTag[];
  readonly joinedAt: number;
}

export interface ActiveRoom {
  readonly id: RoomId;
  readonly users: readonly [SocketId, SocketId];
  readonly topic: string;
  readonly startTime: number;
  readonly duration: number;
  readonly isInterestMatch: boolean;
  readonly commonTag?: string;
  lastActivity: number;
}

export interface MatchResult {
  readonly matchId: SocketId | null;
  readonly commonTag: string | null;
}

export interface RateLimitState {
  messages: number[];
  lastReset: number;
  lastTyping: number;
}

export interface ServerToClientEvents {
  system: (message: string, callback?: (ack: boolean) => void) => void;
  matched: (data: {
    roomId: RoomId;
    topic: string;
    duration: number;
    isInterestMatch: boolean;
  }, callback?: (ack: boolean) => void) => void;
  msg: (data: {
    from: SocketId;
    text: string;
    timestamp: number;
    serverId: string;
  }) => void;
  room_ended: (data: { reason: string }) => void;
  room_closed: (data: { roomId: RoomId }) => void;
  stats: (data: {
    activeRooms: number;
    waitingUsers: number;
    totalConnections: number;
    timestamp: number;
  }) => void;
  typing: (data: { from: SocketId; isTyping: boolean }) => void;
  search  : (d: { tags: string[] }) => void;
}

export interface ClientToServerEvents {
  find: (data: { tags?: string[] }, callback?: (result: { success: boolean; queued?: boolean; message?: string }) => void) => void;
  message: (data: { roomId: RoomId; text: string }, callback?: (result: { success: boolean; timestamp?: number; textLength?: number; message?: string }) => void) => void;
  skip: (callback?: (result: { success: boolean; message?: string }) => void) => void;
  end: (data: { roomId: RoomId }, callback?: (result: { success: boolean; message?: string }) => void) => void;
  typing: (data: { roomId: RoomId; isTyping: boolean }) => void;
}

// Strongly typed storage with explicit generics
const waitingUsers = new Map<SocketId, WaitingUser>();
const activeRooms = new Map<RoomId, ActiveRoom>();
const userRoomMap = new Map<SocketId, RoomId>();
const roomTimers = new Map<RoomId, NodeJS.Timeout>();
const rateLimits = new Map<SocketId, RateLimitState>();
const claimed = new Set<SocketId>();

// Optimized tag queues with Sets for O(1) operations
const tagQueues = new Map<NormalizedTag, Set<SocketId>>();

// Enhanced metrics tracking
interface Metrics {
  matchesCreated: number;
  interestMatches: number;
  randomMatches: number;
  skips: number;
  ends: number;
  rateLimitHits: number;
  messagesTotal: number;
  exactTagMatches: number;
  fuzzyTagMatches: number;
  fallbackMatches: number;
}

const metrics: Metrics = {
  matchesCreated: 0,
  interestMatches: 0,
  randomMatches: 0,
  skips: 0,
  ends: 0,
  rateLimitHits: 0,
  messagesTotal: 0,
  exactTagMatches: 0,
  fuzzyTagMatches: 0,
  fallbackMatches: 0
};

// Enhanced debate topics with categorization
const DEBATE_TOPICS = {
  food: ["Pineapple belongs on pizza", "Is cereal a soup?", "Should you put milk or cereal first?"],
  animals: ["Cats are better than dogs", "Are birds real or government drones?"],
  philosophy: ["Is math invented or discovered?", "Is time travel possible?", "Should robots have rights?"],
  society: ["Is social media good or bad for society?", "Should college be free?", "Is remote work better than office work?"],
  science: ["Should we colonize Mars?", "Is artificial intelligence a threat to humanity?", "Is nuclear energy safe?"],
  lifestyle: ["Should you shower in the morning or at night?", "Should toilet paper hang over or under?", "Is it better to be too hot or too cold?"],
  general: ["Is a hotdog a sandwich?", "Is water wet?", "Would you rather fight 100 duck-sized horses or 1 horse-sized duck?", "Are video games a sport?"]
};

const ALL_TOPICS = Object.values(DEBATE_TOPICS).flat();

// Utility functions with proper typing
function normalizeTag(tag: string): NormalizedTag {
  return tag.toLowerCase().trim().replace(/[^a-z0-9]/g, '') as NormalizedTag;
}

function generateRoomId(): RoomId {
  return crypto.randomUUID() as RoomId;
}

function createSocketId(id: string): SocketId {
  return id as SocketId;
}

function validateTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  const validTags = tags
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 24)
    .slice(0, 10) // Limit to 10 tags
    .map(tag => tag.trim())
    .filter(Boolean);

  // Deduplicate after normalization
  const seen = new Set<string>();
  return validTags.filter(tag => {
    const normalized = normalizeTag(tag);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function validateMessage(text: unknown): string | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) return null;
  return text.trim();
}

function generateInterestPrompt(interest: string): string {
  const prompts = [
    `Is ${interest} overrated?`,
    `Should everyone try ${interest}?`,
    `Is ${interest} worth the hype?`,
    `What's the best thing about ${interest}?`,
    `Is ${interest} a waste of time or valuable hobby?`,
    `How important is ${interest} in modern life?`,
    `Would the world be better with more ${interest}?`
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function getRandomTopic(): string {
  return ALL_TOPICS[Math.floor(Math.random() * ALL_TOPICS.length)];
}

// Enhanced tag queue management
function addToTagQueues(socketId: SocketId, normalizedTags: readonly NormalizedTag[]): void {
  normalizedTags.forEach(tag => {
    if (!tagQueues.has(tag)) {
      tagQueues.set(tag, new Set());
    }
    tagQueues.get(tag)!.add(socketId);
  });
}

function removeFromTagQueues(socketId: SocketId): void {
  for (const [tag, queue] of tagQueues.entries()) {
    queue.delete(socketId);
    if (queue.size === 0) {
      tagQueues.delete(tag);
    }
  }
}

// Race-condition safe matching with atomic claims
function findMatch(socketId: SocketId, normalizedTags: readonly NormalizedTag[]): MatchResult {
  // 1. Exact tag matches (O(1) lookup)
  for (const userTag of normalizedTags) {
    const queue = tagQueues.get(userTag);
    if (queue) {
      for (const candidateId of queue) {
        if (candidateId === socketId) continue;

        // Atomic claim check
        if (claimed.has(candidateId)) continue;

        const waitingUser = waitingUsers.get(candidateId);
        if (!waitingUser) {
          // Stale queue entry, remove it
          queue.delete(candidateId);
          continue;
        }

        // Successfully claim the match
        claimed.add(candidateId);

        const originalTag = waitingUser.tags.find(tag => 
          normalizeTag(tag) === userTag
        ) || userTag;

        metrics.exactTagMatches++;

        return { 
          matchId: candidateId, 
          commonTag: originalTag 
        };
      }
    }
  }

  // 2. Fuzzy matching (only for small queues to avoid O(n²))
  if (waitingUsers.size < 500) {
    for (const [candidateId, waitingData] of waitingUsers.entries()) {
      if (candidateId === socketId || claimed.has(candidateId)) continue;

      for (const userTag of normalizedTags) {
        const similarTag = waitingData.normalizedTags.find(waitingTag => 
          waitingTag !== userTag && (
            waitingTag.startsWith(userTag) || 
            userTag.startsWith(waitingTag) ||
            (userTag.length > 3 && waitingTag.length > 3 && 
             (waitingTag.includes(userTag) || userTag.includes(waitingTag)))
          )
        );

        if (similarTag) {
          claimed.add(candidateId);

          const originalTag = waitingData.tags.find(tag => 
            normalizeTag(tag) === similarTag
          ) || similarTag;

          metrics.fuzzyTagMatches++;

          return { 
            matchId: candidateId, 
            commonTag: originalTag 
          };
        }
      }
    }
  }

  // 3. Fallback to any available user
  for (const [candidateId] of waitingUsers.entries()) {
    if (candidateId !== socketId && !claimed.has(candidateId)) {
      claimed.add(candidateId);
      metrics.fallbackMatches++;
      return { matchId: candidateId, commonTag: null };
    }
  }

  return { matchId: null, commonTag: null };
}

// Enhanced rate limiting with typing throttle
function checkMessageRateLimit(socketId: SocketId): boolean {
  const now = Date.now();
  const limit = rateLimits.get(socketId) || { messages: [], lastReset: now, lastTyping: 0 };

  // Reset every minute
  if (now - limit.lastReset > 60000) {
    limit.messages = [];
    limit.lastReset = now;
  }

  limit.messages.push(now);
  // Keep only messages from last minute and cap at 50 to prevent memory growth
  limit.messages = limit.messages.filter(time => now - time < 60000).slice(-50);

  rateLimits.set(socketId, limit);

  const allowed = limit.messages.length <= 30;
  if (!allowed) metrics.rateLimitHits++;

  return allowed;
}

function checkTypingRateLimit(socketId: SocketId): boolean {
  const now = Date.now();
  const limit = rateLimits.get(socketId) || { messages: [], lastReset: now, lastTyping: 0 };

  const allowed = now - limit.lastTyping > 1500; // 1.5 seconds between typing events
  if (allowed) {
    limit.lastTyping = now;
    rateLimits.set(socketId, limit);
  }

  return allowed;
}

// Room timer management
function startRoomTimer(roomId: RoomId, duration: number): void {
  clearRoomTimer(roomId);
  const timer = setTimeout(() => {
    endRoom(roomId, 'Time expired');
  }, duration);
  roomTimers.set(roomId, timer);

  logger.info({ roomId, duration }, 'Room timer started');
}

// FIXED: Proper timer cleanup with correct type handling
function clearRoomTimer(roomId: RoomId): void {
  const timer = roomTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    roomTimers.delete(roomId); // FIXED: Delete the roomId, not the timer
    logger.debug({ roomId }, 'Room timer cleared');
  }
}

// Enhanced room lifecycle with requeue support
function endRoom(roomId: RoomId, reason: string, skipperSocketId?: SocketId): void {
  const room = activeRooms.get(roomId);
  if (!room) return;

  logger.info({ 
    roomId, 
    reason, 
    duration: Date.now() - room.startTime,
    messageCount: metrics.messagesTotal
  }, 'Ending room');

  clearRoomTimer(roomId);

  // Release claims for both users
  room.users.forEach(userId => claimed.delete(userId));

  // Notify users
  io.to(roomId).emit('room_ended', { reason });
  io.to(roomId).emit('room_closed', { roomId });

  // Handle skip and requeue logic
  if (skipperSocketId && reason === 'User skipped') {
    const partner = room.users.find(id => id !== skipperSocketId);

    // Requeue the partner if they're still connected
    if (partner) {
      const partnerSocket = io.sockets.sockets.get(partner);
      if (partnerSocket) {
        // Find partner's original tags from waiting history or use empty array
        setTimeout(() => {
          partnerSocket.emit('system', 'Your partner left. Finding you a new opponent...');
          // Auto-requeue with empty tags for simplicity
          // FIXED: Use proper interface format
          const findData = { tags: [] };
          partnerSocket.emit('search', findData);
        }, 1000);
      }
    }
  }

  // Clean up users
  room.users.forEach((userId: SocketId) => {
    userRoomMap.delete(userId);
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.leave(roomId);
    }
  });

  activeRooms.delete(roomId);

  // Update metrics
  if (reason === 'User skipped') metrics.skips++;
  else if (reason === 'User ended the debate') metrics.ends++;
}

// Inactivity monitoring
setInterval(() => {
  const inactivityTimeout = 15 * 60 * 1000; // 15 minutes
  const now = Date.now();

  for (const [roomId, room] of activeRooms.entries()) {
    if (now - room.lastActivity > inactivityTimeout) {
      endRoom(roomId, 'Inactivity timeout');
    }
  }
}, 60000); // Check every minute

// Stale user cleanup
setInterval(() => {
  const staleTimeout = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  for (const [socketId, user] of waitingUsers.entries()) {
    if (now - user.joinedAt > staleTimeout) {
      waitingUsers.delete(socketId);
      removeFromTagQueues(socketId);
      claimed.delete(socketId);
      logger.debug({ socketId }, 'Removed stale waiting user');
    }
  }
}, 30000); // Check every 30 seconds

// Express app with enhanced security
const app = express();
const server = http.createServer(app);

// Production-ready CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',').filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow same-origin
    return callback(null, allowedOrigins.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Enhanced security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", ...allowedOrigins],
      scriptSrc: ["'self'", "'unsafe-inline'"], // For Socket.IO client
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Reduced body limits for security
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Socket.IO with enhanced configuration
const io = new IOServer<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e5, // 100KB
  allowEIO3: false
});

// Enhanced socket connection handling with acknowledgements
io.on('connection', (socket) => {
  const socketId = createSocketId(socket.id);

  logger.info({ socketId }, 'User connected');

  socket.on('find', (rawData, callback) => {
    try {
      const tags = validateTags(rawData?.tags);

      if (userRoomMap.has(socketId)) {
        const result = { success: false, message: 'You are already in a debate!' };
        socket.emit('system', result.message);
        callback?.(result);
        return;
      }

      const normalizedTags = tags.map(normalizeTag);

      logger.info({ 
        socketId, 
        tags, 
        normalizedTags,
        queueSize: waitingUsers.size
      }, 'User searching for match');

      const matchResult = findMatch(socketId, normalizedTags);
      const { matchId, commonTag } = matchResult;

      if (matchId) {
        const roomId = generateRoomId();
        const duration = parseInt(process.env.ROOM_DURATION_MS || '300000'); // 5 minutes

        let topic: string;
        let isInterestMatch = false;

        if (commonTag) {
          topic = generateInterestPrompt(commonTag);
          isInterestMatch = true;
          metrics.interestMatches++;
          logger.info({ roomId, commonTag, topic }, 'Interest-based match created');
        } else {
          topic = getRandomTopic();
          metrics.randomMatches++;
          logger.info({ roomId, topic }, 'Random topic match created');
        }

        const room: ActiveRoom = {
          id: roomId,
          users: [socketId, matchId],
          topic,
          startTime: Date.now(),
          duration,
          isInterestMatch,
          commonTag: commonTag || undefined,
          lastActivity: Date.now()
        };

        activeRooms.set(roomId, room);
        userRoomMap.set(socketId, roomId);
        userRoomMap.set(matchId, roomId);

        // Clean up waiting state
        waitingUsers.delete(matchId);
        removeFromTagQueues(matchId);
        claimed.delete(matchId); // Release claim

        // Join room
        socket.join(roomId);
        io.sockets.sockets.get(matchId)?.join(roomId);

        // Start timer
        startRoomTimer(roomId, duration);

        // Notify users with acknowledgment
        io.to(roomId).emit('matched', {
          roomId,
          topic,
          duration,
          isInterestMatch
        }, (ack) => {
          logger.debug({ roomId, ack }, 'Match notification acknowledged');
        });

        metrics.matchesCreated++;

        callback?.({ success: true, queued: false, message: 'Matched successfully!' });

      } else {
        // Add to waiting queue
        const waitingUser: WaitingUser = {
          socketId,
          tags,
          normalizedTags,
          joinedAt: Date.now()
        };

        waitingUsers.set(socketId, waitingUser);
        addToTagQueues(socketId, normalizedTags);

        socket.emit('system', 'Waiting for an opponent...');
        callback?.({ success: true, queued: true, message: 'Added to queue' });
      }

    } catch (error) {
      logger.error({ error, socketId }, 'Error in find handler');
      const result = { success: false, message: 'Search failed' };
      socket.emit('system', result.message);
      callback?.(result);
    }
  });

  socket.on('message', (rawData, callback) => {
    try {
      const roomId = rawData?.roomId as RoomId;
      const text = validateMessage(rawData?.text);

      if (!text) {
        callback?.({ success: false, message: 'Invalid message' });
        return;
      }

      if (!checkMessageRateLimit(socketId)) {
        socket.emit('system', 'Message rate limit exceeded');
        callback?.({ success: false, message: 'Rate limited' });
        return;
      }

      const room = activeRooms.get(roomId);
      if (!room || !room.users.includes(socketId)) {
        callback?.({ success: false, message: 'Not in room' });
        return;
      }

      // Update room activity
      room.lastActivity = Date.now();

      const serverId = crypto.randomUUID();
      const timestamp = Date.now();

      // Broadcast to other users in room
      socket.to(roomId).emit('msg', {
        from: socketId,
        text,
        timestamp,
        serverId
      });

      metrics.messagesTotal++;

      logger.debug({ 
        roomId, 
        from: socketId, 
        textLength: text.length,
        serverId
      }, 'Message sent');

      callback?.({ 
        success: true, 
        timestamp, 
        textLength: text.length 
      });

    } catch (error) {
      logger.error({ error, socketId }, 'Error in message handler');
      callback?.({ success: false, message: 'Message failed' });
    }
  });

  socket.on('typing', (rawData) => {
    try {
      const roomId = rawData?.roomId as RoomId;
      const isTyping = Boolean(rawData?.isTyping);

      if (!checkTypingRateLimit(socketId)) return;

      const room = activeRooms.get(roomId);
      if (!room || !room.users.includes(socketId)) return;

      socket.to(roomId).emit('typing', { from: socketId, isTyping });

    } catch (error) {
      logger.error({ error, socketId }, 'Error in typing handler');
    }
  });

  socket.on('skip', (callback) => {
    try {
      const roomId = userRoomMap.get(socketId);

      if (!roomId) {
        waitingUsers.delete(socketId);
        removeFromTagQueues(socketId);
        claimed.delete(socketId);
        socket.emit('system', 'Search cancelled');
        callback?.({ success: true, message: 'Search cancelled' });
        return;
      }

      endRoom(roomId, 'User skipped', socketId);
      logger.info({ socketId, roomId }, 'User skipped debate');

      callback?.({ success: true, message: 'Skipped successfully' });

    } catch (error) {
      logger.error({ error, socketId }, 'Error in skip handler');
      callback?.({ success: false, message: 'Skip failed' });
    }
  });

  socket.on('end', (rawData, callback) => {
    try {
      const roomId = rawData?.roomId as RoomId;
      const room = activeRooms.get(roomId);

      if (!room || !room.users.includes(socketId)) {
        callback?.({ success: false, message: 'Not in room' });
        return;
      }

      endRoom(roomId, 'User ended the debate');
      logger.info({ socketId, roomId }, 'User ended debate');

      callback?.({ success: true, message: 'Ended successfully' });

    } catch (error) {
      logger.error({ error, socketId }, 'Error in end handler');
      callback?.({ success: false, message: 'End failed' });
    }
  });

  socket.on('disconnect', (reason) => {
    logger.info({ socketId, reason }, 'User disconnected');

    // Clean up waiting state
    waitingUsers.delete(socketId);
    removeFromTagQueues(socketId);
    rateLimits.delete(socketId);
    claimed.delete(socketId);

    // End active room if in one
    const roomId = userRoomMap.get(socketId);
    if (roomId) {
      endRoom(roomId, 'User disconnected');
    }
  });
});

// Real-time stats broadcasting
const statsInterval = setInterval(() => {
  const stats = {
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalConnections: io.sockets.sockets.size,
    timestamp: Date.now()
  };

  io.emit('stats', stats);
}, 3000);

// Enhanced API endpoints
app.get('/api/stats', (req: express.Request, res: express.Response) => {
  const stats = {
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalConnections: io.sockets.sockets.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    tagQueues: tagQueues.size,
    metrics
  };

  res.json(stats);
});

app.get('/api/health', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    gitSha: process.env.GIT_SHA || 'unknown',
    nodeVersion: process.version
  });
});

// FIXED: Proper return path handling
app.get('/api/rooms/:id', (req: express.Request, res: express.Response) => {
  const roomId = req.params.id as RoomId;
  const room = activeRooms.get(roomId);

  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return; // FIXED: Explicit return to satisfy TypeScript
  }

  // Return room metadata without PII
  res.json({
    id: room.id,
    topic: room.topic,
    isInterestMatch: room.isInterestMatch,
    startTime: room.startTime,
    duration: room.duration,
    userCount: room.users.length,
    lastActivity: room.lastActivity
  });
});

// Enhanced Prometheus metrics
app.get('/metrics', (req: express.Request, res: express.Response) => {
  const metricLines = [
    `# HELP debate_active_rooms Number of active debate rooms`,
    `# TYPE debate_active_rooms gauge`,
    `debate_active_rooms ${activeRooms.size}`,

    `# HELP debate_waiting_users Number of users waiting for matches`,
    `# TYPE debate_waiting_users gauge`, 
    `debate_waiting_users ${waitingUsers.size}`,

    `# HELP debate_total_connections Total WebSocket connections`,
    `# TYPE debate_total_connections gauge`,
    `debate_total_connections ${io.sockets.sockets.size}`,

    `# HELP debate_matches_created_total Total matches created`,
    `# TYPE debate_matches_created_total counter`,
    `debate_matches_created_total ${metrics.matchesCreated}`,

    `# HELP debate_interest_matches_total Interest-based matches`,
    `# TYPE debate_interest_matches_total counter`,
    `debate_interest_matches_total ${metrics.interestMatches}`,

    `# HELP debate_messages_total Total messages sent`,
    `# TYPE debate_messages_total counter`,
    `debate_messages_total ${metrics.messagesTotal}`,

    `# HELP debate_rate_limit_hits_total Rate limit violations`,
    `# TYPE debate_rate_limit_hits_total counter`,
    `debate_rate_limit_hits_total ${metrics.rateLimitHits}`,

    `# HELP debate_uptime_seconds Server uptime in seconds`,
    `# TYPE debate_uptime_seconds counter`,
    `debate_uptime_seconds ${Math.floor(process.uptime())}`
  ].join('\n');

  res.set('Content-Type', 'text/plain');
  res.send(metricLines);
});

// Serve enhanced UI with typing indicators and fixed scrolling
app.get('/', (req: express.Request, res: express.Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Debate Omegle - Random Debate Platform</title>
    <style>
        * { box-sizing: border-box; }
        html, body { height: 100%; overflow: hidden; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0f0f, #1a1a1a);
            color: #eee; margin: 0; padding: 10px;
            display: flex; flex-direction: column; height: 100vh;
        }

        .header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 15px 20px; background: rgba(28, 28, 28, 0.9);
            border-radius: 12px; margin-bottom: 15px;
            backdrop-filter: blur(10px); border: 1px solid #333;
            flex-shrink: 0;
        }

        .header h1 {
            margin: 0; font-size: 1.8em; color: #4db6ff;
            display: flex; align-items: center; gap: 10px;
        }

        .stats-container { display: flex; gap: 15px; align-items: center; }

        .stat-card {
            background: linear-gradient(135deg, rgba(77, 182, 255, 0.1), rgba(77, 182, 255, 0.05));
            border: 1px solid rgba(77, 182, 255, 0.3);
            border-radius: 10px; padding: 12px 16px;
            text-align: center; min-width: 90px;
            transition: all 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(77, 182, 255, 0.2);
        }

        .stat-number { font-size: 1.4em; font-weight: 700; color: #4db6ff; line-height: 1; margin-bottom: 4px; }
        .stat-label { font-size: 0.8em; color: #aaa; text-transform: uppercase; }

        .stat-card.online { background: linear-gradient(135deg, rgba(46, 213, 115, 0.15), rgba(46, 213, 115, 0.05)); border-color: rgba(46, 213, 115, 0.3); }
        .stat-card.online .stat-number { color: #2ed573; }
        .stat-card.debates { background: linear-gradient(135deg, rgba(255, 107, 107, 0.15), rgba(255, 107, 107, 0.05)); border-color: rgba(255, 107, 107, 0.3); }
        .stat-card.debates .stat-number { color: #ff6b6b; }
        .stat-card.waiting { background: linear-gradient(135deg, rgba(255, 184, 0, 0.15), rgba(255, 184, 0, 0.05)); border-color: rgba(255, 184, 0, 0.3); }
        .stat-card.waiting .stat-number { color: #ffb800; }

        .container {
            display: flex; gap: 15px; flex: 1; overflow: hidden;
            max-width: 1200px; margin: 0 auto; width: 100%;
        }

        .chat-area {
            flex: 1; background: #1c1c1c; border-radius: 15px; padding: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.7); border: 1px solid #333; 
            display: flex; flex-direction: column; overflow: hidden;
        }

        #topic {
            text-align: center; margin: 0 0 15px 0; font-weight: bold; font-size: 1.1em;
            color: #4db6ff; padding: 12px; background: rgba(77, 182, 255, 0.1);
            border-radius: 8px; border: 1px solid rgba(77, 182, 255, 0.3);
            min-height: 45px; display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
        }

        #topic.interest-match {
            background: linear-gradient(135deg, rgba(46, 213, 115, 0.15), rgba(46, 213, 115, 0.05));
            border-color: rgba(46, 213, 115, 0.4); color: #2ed573;
        }

        .chat-container {
            flex: 1; display: flex; flex-direction: column; overflow: hidden;
        }

        #chat {
            background: #222; padding: 15px; flex: 1; overflow-y: auto;
            border-radius: 10px; border: 1px solid #333;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; line-height: 1.5;
        }

        .typing-indicator {
            min-height: 20px; padding: 5px 15px; color: #aaa; font-style: italic;
            font-size: 0.9em; background: #222; border-radius: 0 0 10px 10px;
            border: 1px solid #333; border-top: none; flex-shrink: 0;
        }

        .msg { 
            margin: 8px 0; padding: 8px 12px; border-radius: 8px; 
            word-wrap: break-word; animation: slideIn 0.2s ease;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .msg.me { 
            color: #4db6ff; background: rgba(77, 182, 255, 0.15);
            border-left: 3px solid #4db6ff; margin-left: 20px;
        }

        .msg.other { 
            color: #ff7a7a; background: rgba(255, 122, 122, 0.15);
            border-left: 3px solid #ff7a7a; margin-right: 20px;
        }

        .msg.system { 
            color: #aaa; font-style: italic; text-align: center;
            background: rgba(170, 170, 170, 0.05); border-radius: 20px;
            font-size: 0.9em; margin: 10px 0;
        }

        #inputArea { display: flex; gap: 10px; margin: 15px 0; flex-shrink: 0; }

        #inputArea input {
            flex: 1; padding: 12px; border: 1px solid #444; border-radius: 8px;
            background: #2a2a2a; color: #eee; font-size: 14px; transition: all 0.2s;
        }

        #inputArea input:focus {
            outline: none; border-color: #4db6ff; background: #333;
            box-shadow: 0 0 0 2px rgba(77, 182, 255, 0.2);
        }

        #controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; flex-shrink: 0; }

        #controls input {
            flex: 1; min-width: 200px; padding: 12px; border: 1px solid #444;
            border-radius: 8px; background: #2a2a2a; color: #eee; font-size: 14px;
        }

        button {
            padding: 12px 20px; border: none; border-radius: 8px;
            background: #4db6ff; color: white; cursor: pointer;
            font-weight: 600; font-size: 14px; transition: all 0.2s ease;
        }

        button:hover:not(:disabled) {
            background: #3da8ef; transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(77, 182, 255, 0.3);
        }

        button:disabled { background: #555; color: #999; cursor: not-allowed; }

        #skipBtn { background: #ff9500; }
        #skipBtn:hover:not(:disabled) { background: #e6850e; }
        #endBtn { background: #ff4757; }
        #endBtn:hover:not(:disabled) { background: #e73c4e; }

        .status-dot {
            width: 8px; height: 8px; border-radius: 50%; background: #2ed573;
            margin-right: 8px; animation: pulse 2s infinite;
        }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

        #chat::-webkit-scrollbar { width: 8px; }
        #chat::-webkit-scrollbar-track { background: #1a1a1a; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb:hover { background: #666; }

        @media (max-width: 768px) {
            body { height: 100vh; }
            .container { flex-direction: column; }
            .header { flex-direction: column; gap: 15px; }
            .stats-container { justify-content: center; flex-wrap: wrap; }
            #controls { flex-direction: column; }
            #controls input { min-width: auto; }
        }

        .typing-dots { animation: dots 1.5s steps(4, end) infinite; }

        @keyframes dots {
            0%, 20% { color: transparent; text-shadow: .25em 0 0 transparent, .5em 0 0 transparent; }
            40% { color: #aaa; text-shadow: .25em 0 0 transparent, .5em 0 0 transparent; }
            60% { text-shadow: .25em 0 0 #aaa, .5em 0 0 transparent; }
            80%, 100% { text-shadow: .25em 0 0 #aaa, .5em 0 0 #aaa; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1><span class="status-dot"></span>🗣️ Debate Omegle</h1>
        <div class="stats-container">
            <div class="stat-card online">
                <div class="stat-number" id="online">0</div>
                <div class="stat-label">Online</div>
            </div>
            <div class="stat-card debates">
                <div class="stat-number" id="debates">0</div>
                <div class="stat-label">Debates</div>
            </div>
            <div class="stat-card waiting">
                <div class="stat-number" id="waiting">0</div>
                <div class="stat-label">Waiting</div>
            </div>
        </div>
    </div>

    <div class="container">
        <div class="chat-area">
            <div id="topic">Connect with strangers for random debates on interesting topics!</div>

            <div class="chat-container">
                <div id="chat"></div>
                <div class="typing-indicator" id="typingIndicator"></div>
            </div>

            <div id="inputArea">
                <input type="text" id="messageBox" placeholder="Type your argument..." disabled maxlength="500">
                <button id="sendBtn" disabled>Send</button>
            </div>

            <div id="controls">
                <input type="text" id="tags" placeholder="Enter interests: cats, gaming, politics, music..." maxlength="100">
                <button id="startBtn">Find Debate Partner</button>
                <button id="skipBtn" disabled>Skip Partner</button>
                <button id="endBtn" disabled>End Debate</button>
            </div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io({ transports: ['websocket'] });
        const chatEl = document.getElementById('chat');
        const topicEl = document.getElementById('topic');
        const msgBox = document.getElementById('messageBox');
        const sendBtn = document.getElementById('sendBtn');
        const startBtn = document.getElementById('startBtn');
        const skipBtn = document.getElementById('skipBtn');
        const endBtn = document.getElementById('endBtn');
        const typingIndicator = document.getElementById('typingIndicator');
        let currentRoom = null;
        let typingTimeout = null;
        let isTyping = false;

        function addMessage(text, type = 'system') {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'msg ' + type;
            msgDiv.textContent = text;
            chatEl.appendChild(msgDiv);
            chatEl.scrollTop = chatEl.scrollHeight;
        }

        function resetUI() {
            startBtn.disabled = false; startBtn.textContent = 'Find Debate Partner';
            skipBtn.disabled = true; endBtn.disabled = true;
            msgBox.disabled = true; sendBtn.disabled = true;
            currentRoom = null; topicEl.classList.remove('interest-match');
            typingIndicator.textContent = '';
        }

        function handleTyping() {
            if (!currentRoom || isTyping) return;

            isTyping = true;
            socket.emit('typing', { roomId: currentRoom, isTyping: true });

            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                isTyping = false;
                socket.emit('typing', { roomId: currentRoom, isTyping: false });
            }, 2000);
        }

        startBtn.onclick = () => {
            const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
            socket.emit('find', { tags }, (result) => {
                if (result.success) {
                    if (tags.length > 0) {
                        addMessage('🔎 Searching for someone interested in: ' + tags.join(', ') + '...', 'system');
                    } else {
                        addMessage('🔎 Searching for any debate partner...', 'system');
                    }
                    startBtn.disabled = true; startBtn.textContent = 'Searching...';
                    skipBtn.disabled = false; endBtn.disabled = false;
                } else {
                    addMessage('❌ ' + result.message, 'system');
                }
            });
        };

        skipBtn.onclick = () => {
            socket.emit('skip', (result) => {
                if (result.success) {
                    chatEl.innerHTML = '';
                    topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
                    resetUI();
                    addMessage('⏭️ Skipped partner. Click "Find Debate Partner" to search again.', 'system');
                }
            });
        };

        endBtn.onclick = () => {
            if (currentRoom) {
                socket.emit('end', { roomId: currentRoom }, (result) => {
                    if (result.success) {
                        chatEl.innerHTML = '';
                        topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
                        resetUI();
                        addMessage('🏁 Debate ended. Click "Find Debate Partner" for another round.', 'system');
                    }
                });
            }
        };

        sendBtn.onclick = () => {
            if (!currentRoom) return;
            const text = msgBox.value.trim();
            if (!text) return;

            addMessage('You: ' + text, 'me');
            socket.emit('message', { roomId: currentRoom, text }, (result) => {
                if (!result.success) {
                    addMessage('❌ Failed to send: ' + result.message, 'system');
                }
            });
            msgBox.value = '';
        };

        msgBox.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendBtn.click();
            } else {
                handleTyping();
            }
        });

        msgBox.addEventListener('input', handleTyping);

        socket.on('connect', () => {
            addMessage('✅ Connected to Debate Omegle!', 'system');
        });

        socket.on('disconnect', () => {
            addMessage('❌ Disconnected. Reconnecting...', 'system');
            resetUI();
        });

        socket.on('system', (msg) => addMessage(msg, 'system'));

        socket.on('matched', ({ roomId, topic, duration, isInterestMatch }) => {
            currentRoom = roomId; chatEl.innerHTML = '';
            const durationMin = Math.floor(duration / 1000 / 60);

            if (isInterestMatch) {
                topicEl.textContent = topic;
                topicEl.classList.add('interest-match');
                addMessage('🎉 Perfect match! You both share this interest. Start your conversation!', 'system');
            } else {
                topicEl.innerHTML = '🎯 <strong>Debate Topic:</strong> ' + topic + ' <small>(' + durationMin + ' min)</small>';
                topicEl.classList.remove('interest-match');
                addMessage('🎉 Connected to opponent! Start your debate now. Be respectful!', 'system');
            }

            msgBox.disabled = false; sendBtn.disabled = false;
            msgBox.focus();
        });

        socket.on('msg', ({ from, text }) => {
            addMessage('Opponent: ' + text, 'other');
        });

        socket.on('typing', ({ from, isTyping }) => {
            if (isTyping) {
                typingIndicator.innerHTML = 'Opponent is typing<span class="typing-dots">...</span>';
            } else {
                typingIndicator.textContent = '';
            }
        });

        socket.on('room_ended', ({ reason }) => {
            addMessage('💬 Chat ended: ' + reason, 'system');
            addMessage('Thanks for the great conversation! Click "Find Debate Partner" for another round.', 'system');
            resetUI();
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
        });

        socket.on('stats', ({ activeRooms, waitingUsers, totalConnections }) => {
            document.getElementById('online').textContent = totalConnections;
            document.getElementById('debates').textContent = activeRooms;
            document.getElementById('waiting').textContent = waitingUsers;
        });

        addMessage('Welcome to Debate Omegle! 🎉', 'system');
        addMessage('Enter your interests (separated by commas) to find people with similar hobbies, or leave blank for random debates.', 'system');
    </script>
</body>
</html>`);
});

// Graceful shutdown with proper cleanup
let isShuttingDown = false;

const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing server gracefully');

  // Stop intervals
  clearInterval(statsInterval);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');

    // End all active rooms
    for (const [roomId] of activeRooms) {
      endRoom(roomId, 'Server maintenance');
    }

    // Close Socket.IO
    io.close(() => {
      logger.info('Socket.IO server closed');

      // Clear all timers
      for (const [roomId] of roomTimers) {
        clearRoomTimer(roomId);
      }

      logger.info('Graceful shutdown completed');
      process.exit(0);
    });
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info({ 
    port: PORT,
    host: HOST,
    env: process.env.NODE_ENV || 'development',
    origins: allowedOrigins,
    gitSha: process.env.GIT_SHA || 'unknown'
  }, '🚀 Enterprise Debate Omegle server started');
});

export { io, app, server };
