import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty'
  } : undefined
});

const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// FIXED: Type definitions with consistent null/undefined usage
type SocketId = string;
type RoomId = string;
type UserId = string;

interface WaitingUser {
  socketId: SocketId;
  userId: UserId;
  tags: string[];
  joinedAt: number;
}

interface ActiveRoom {
  id: RoomId;
  users: SocketId[];
  userIds: UserId[];
  topic: string;
  startTime: number;
  duration: number;
  isInterestMatch: boolean;
  commonTag?: string; // FIXED: Use undefined instead of null for consistency
  lastActivity: number;
}

interface MatchResult {
  matchId: SocketId | null;
  matchUserId: UserId | null;
  commonTag: string | null; // Keep null here for logic, but convert when storing
}

interface ServerToClientEvents {
  system: (message: string) => void;
  matched: (data: {
    roomId: RoomId;
    topic: string;
    duration: number;
    isInterestMatch: boolean;
  }) => void;
  msg: (data: {
    from: SocketId;
    text: string;
    timestamp: number;
  }) => void;
  room_ended: (data: { reason: string }) => void;
  room_closed: (data: { roomId: RoomId }) => void;
  stats: (data: {
    activeRooms: number;
    waitingUsers: number;
    totalConnections: number;
    timestamp: number;
  }) => void;
  typing: (data: { from: SocketId }) => void;
}

interface ClientToServerEvents {
  find: (data: { tags?: string[] }) => void;
  message: (data: { roomId: RoomId; text: string }) => void;
  skip: () => void;
  end: (data: { roomId: RoomId }) => void;
  typing: (data: { roomId: RoomId }) => void;
}

// Strongly typed storage
const waitingUsers = new Map<SocketId, WaitingUser>();
const activeRooms = new Map<RoomId, ActiveRoom>();
const userRoomMap = new Map<SocketId, RoomId>();
const roomTimers = new Map<RoomId, NodeJS.Timeout>();
const userSocketMap = new Map<UserId, SocketId>();

// Rate limiting storage
const rateLimits = new Map<SocketId, { messages: number[]; lastReset: number }>();

// Enhanced debate topics
const DEBATE_TOPICS: string[] = [
  "Pineapple belongs on pizza",
  "Cats are better than dogs", 
  "Is a hotdog a sandwich?",
  "Should toilet paper hang over or under?",
  "Is water wet?",
  "Are birds real or government drones?",
  "Is cereal a soup?",
  "Should you shower in the morning or at night?",
  "Is math invented or discovered?",
  "Would you rather fight 100 duck-sized horses or 1 horse-sized duck?",
  "Is it better to be too hot or too cold?",
  "Should you put milk or cereal first?",
  "Are video games a sport?",
  "Is time travel possible?",
  "Should robots have rights?",
  "Is social media good or bad for society?",
  "Should we colonize Mars?",
  "Is artificial intelligence a threat to humanity?",
  "Should college be free?",
  "Is remote work better than office work?"
];

function generateInterestPrompt(interest: string): string {
  const prompts = [
    `Is ${interest} overrated?`,
    `Should everyone try ${interest}?`,
    `Is ${interest} worth the hype?`,
    `What's the best thing about ${interest}?`,
    `Is ${interest} a waste of time or valuable hobby?`
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function getRandomTopic(): string {
  return DEBATE_TOPICS[Math.floor(Math.random() * DEBATE_TOPICS.length)];
}

function generateRoomId(): RoomId {
  return `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateUserId(): UserId {
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Enhanced matching with per-tag queues
const tagQueues = new Map<string, SocketId[]>();

function normalizeTag(tag: string): string {
  return tag.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function addToTagQueues(socketId: SocketId, tags: string[]): void {
  tags.forEach(tag => {
    const normalized = normalizeTag(tag);
    if (!tagQueues.has(normalized)) {
      tagQueues.set(normalized, []);
    }
    const queue = tagQueues.get(normalized)!;
    if (!queue.includes(socketId)) {
      queue.push(socketId);
    }
  });
}

function removeFromTagQueues(socketId: SocketId): void {
  for (const [tag, queue] of tagQueues.entries()) {
    const index = queue.indexOf(socketId);
    if (index !== -1) {
      queue.splice(index, 1);
      if (queue.length === 0) {
        tagQueues.delete(tag);
      }
    }
  }
}

function findMatch(socketId: SocketId, userTags: string[]): MatchResult {
  const normalizedUserTags = userTags.map(normalizeTag);

  // 1. Try exact tag matches using queues (O(1) lookup)
  for (const userTag of normalizedUserTags) {
    const queue = tagQueues.get(userTag);
    if (queue) {
      for (const waitingSocketId of queue) {
        if (waitingSocketId === socketId) continue;
        const waitingUser = waitingUsers.get(waitingSocketId);
        if (waitingUser) {
          const originalTag = waitingUser.tags.find(tag => 
            normalizeTag(tag) === userTag
          ) || userTag;

          return { 
            matchId: waitingSocketId, 
            matchUserId: waitingUser.userId, 
            commonTag: originalTag 
          };
        }
      }
    }
  }

  // 2. Fuzzy matching for similar tags
  for (const [socketId2, waitingData] of waitingUsers.entries()) {
    if (socketId2 === socketId) continue;

    const normalizedWaitingTags = waitingData.tags.map(normalizeTag);

    for (const userTag of normalizedUserTags) {
      const similarTag = normalizedWaitingTags.find(waitingTag => 
        waitingTag.startsWith(userTag) || 
        userTag.startsWith(waitingTag) ||
        (userTag.length > 3 && waitingTag.length > 3 && 
         (waitingTag.includes(userTag) || userTag.includes(waitingTag)))
      );

      if (similarTag) {
        const originalTag = waitingData.tags.find(tag => 
          normalizeTag(tag) === similarTag
        ) || similarTag;

        return { 
          matchId: socketId2, 
          matchUserId: waitingData.userId, 
          commonTag: originalTag 
        };
      }
    }
  }

  // 3. Fallback to any waiting user
  for (const [waitingSocketId, waitingData] of waitingUsers.entries()) {
    if (waitingSocketId !== socketId) {
      return { 
        matchId: waitingSocketId, 
        matchUserId: waitingData.userId, 
        commonTag: null 
      };
    }
  }

  return { matchId: null, matchUserId: null, commonTag: null };
}

// Rate limiting
function checkRateLimit(socketId: SocketId, maxPerMinute: number = 20): boolean {
  const now = Date.now();
  const limit = rateLimits.get(socketId) || { messages: [], lastReset: now };

  // Reset every minute
  if (now - limit.lastReset > 60000) {
    limit.messages = [];
    limit.lastReset = now;
  }

  limit.messages.push(now);
  limit.messages = limit.messages.filter(time => now - time < 60000);

  rateLimits.set(socketId, limit);

  return limit.messages.length <= maxPerMinute;
}

// Room timer management
function startRoomTimer(roomId: RoomId, duration: number): void {
  clearRoomTimer(roomId);
  const timer = setTimeout(() => {
    endRoom(roomId, 'Time expired');
  }, duration);
  roomTimers.set(roomId, timer);
}

function clearRoomTimer(roomId: RoomId): void {
  const timer = roomTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    roomTimers.delete(roomId);
  }
}

// Enhanced room management
function endRoom(roomId: RoomId, reason: string): void {
  const room = activeRooms.get(roomId);
  if (!room) return;

  clearRoomTimer(roomId);

  // Notify users
  io.to(roomId).emit('room_ended', { reason });
  io.to(roomId).emit('room_closed', { roomId });

  // Clean up users
  room.users.forEach((userId: SocketId) => {
    userRoomMap.delete(userId);
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.leave(roomId);
    }
  });

  activeRooms.delete(roomId);
  logger.info({ roomId, reason }, 'Room ended');
}

// Socket.IO with enhanced typing
const io = new IOServer<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Socket connection handling
io.on('connection', (socket) => {
  const userId = generateUserId();
  userSocketMap.set(userId, socket.id);

  logger.info({ socketId: socket.id, userId }, 'User connected');

  socket.on('find', ({ tags = [] }: { tags?: string[] }) => {
    if (userRoomMap.has(socket.id)) {
      socket.emit('system', 'You are already in a debate!');
      return;
    }

    logger.info({ socketId: socket.id, userId, tags }, 'User searching for match');

    const matchResult = findMatch(socket.id, tags);
    const { matchId, matchUserId, commonTag } = matchResult;

    if (matchId && matchUserId) {
      const roomId = generateRoomId();
      const duration = parseInt(process.env.ROOM_DURATION_MS || '300000'); // 5 minutes

      let topic: string;
      let isInterestMatch = false;

      if (commonTag) {
        topic = generateInterestPrompt(commonTag);
        isInterestMatch = true;
        logger.info({ roomId, commonTag, topic }, 'Interest-based match created');
      } else {
        topic = getRandomTopic();
        logger.info({ roomId, topic }, 'Random topic match created');
      }

      // FIXED: Convert null to undefined when storing in ActiveRoom
      const room: ActiveRoom = {
        id: roomId,
        users: [socket.id, matchId],
        userIds: [userId, matchUserId],
        topic,
        startTime: Date.now(),
        duration,
        isInterestMatch,
        commonTag: commonTag || undefined, // FIXED: Convert null to undefined
        lastActivity: Date.now()
      };

      activeRooms.set(roomId, room);
      userRoomMap.set(socket.id, roomId);
      userRoomMap.set(matchId, roomId);

      // Clean up waiting state
      waitingUsers.delete(matchId);
      removeFromTagQueues(matchId);

      // Join room
      socket.join(roomId);
      io.sockets.sockets.get(matchId)?.join(roomId);

      // Start timer
      startRoomTimer(roomId, duration);

      // Notify users
      io.to(roomId).emit('matched', {
        roomId,
        topic,
        duration,
        isInterestMatch
      });

    } else {
      // Add to waiting queue
      const waitingUser: WaitingUser = {
        socketId: socket.id,
        userId,
        tags,
        joinedAt: Date.now()
      };

      waitingUsers.set(socket.id, waitingUser);
      addToTagQueues(socket.id, tags);

      socket.emit('system', 'Waiting for an opponent...');
    }
  });

  socket.on('message', ({ roomId, text }: { roomId: string; text: string }) => {
    if (!checkRateLimit(socket.id, 30)) {
      socket.emit('system', 'Message rate limit exceeded');
      return;
    }

    const room = activeRooms.get(roomId);
    if (!room || !room.users.includes(socket.id)) return;

    // Update room activity
    room.lastActivity = Date.now();

    // Broadcast to other users in room
    socket.to(roomId).emit('msg', {
      from: socket.id,
      text: text.trim(),
      timestamp: Date.now()
    });
  });

  socket.on('typing', ({ roomId }: { roomId: string }) => {
    const room = activeRooms.get(roomId);
    if (!room || !room.users.includes(socket.id)) return;

    socket.to(roomId).emit('typing', { from: socket.id });
  });

  socket.on('skip', () => {
    const roomId = userRoomMap.get(socket.id);

    if (!roomId) {
      waitingUsers.delete(socket.id);
      removeFromTagQueues(socket.id);
      socket.emit('system', 'Search cancelled');
      return;
    }

    endRoom(roomId, 'User skipped');
  });

  socket.on('end', ({ roomId }: { roomId: string }) => {
    const room = activeRooms.get(roomId);
    if (!room || !room.users.includes(socket.id)) return;

    endRoom(roomId, 'User ended the debate');
  });

  socket.on('disconnect', (reason) => {
    logger.info({ socketId: socket.id, userId, reason }, 'User disconnected');

    // Clean up waiting state
    waitingUsers.delete(socket.id);
    removeFromTagQueues(socket.id);
    rateLimits.delete(socket.id);
    userSocketMap.delete(userId);

    // End active room if in one
    const roomId = userRoomMap.get(socket.id);
    if (roomId) {
      endRoom(roomId, 'User disconnected');
    }
  });
});

// Real-time stats broadcasting
setInterval(() => {
  const stats = {
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalConnections: io.sockets.sockets.size,
    timestamp: Date.now()
  };

  io.emit('stats', stats);
}, 3000);

// API endpoints
app.get('/api/stats', (req: express.Request, res: express.Response) => {
  const stats = {
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalConnections: io.sockets.sockets.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    tagQueues: tagQueues.size
  };

  res.json(stats);
});

app.get('/api/health', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

app.get('/metrics', (req: express.Request, res: express.Response) => {
  const metrics = [
    `# HELP debate_active_rooms Number of active debate rooms`,
    `# TYPE debate_active_rooms gauge`,
    `debate_active_rooms ${activeRooms.size}`,
    `# HELP debate_waiting_users Number of users waiting for matches`,
    `# TYPE debate_waiting_users gauge`, 
    `debate_waiting_users ${waitingUsers.size}`,
    `# HELP debate_total_connections Total WebSocket connections`,
    `# TYPE debate_total_connections gauge`,
    `debate_total_connections ${io.sockets.sockets.size}`,
    `# HELP debate_uptime_seconds Server uptime in seconds`,
    `# TYPE debate_uptime_seconds counter`,
    `debate_uptime_seconds ${Math.floor(process.uptime())}`
  ].join('\n');

  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});

app.get('/api/topics', (req: express.Request, res: express.Response) => {
  res.json({ 
    topics: DEBATE_TOPICS, 
    count: DEBATE_TOPICS.length 
  });
});

// Main HTML route with complete UI
app.get('/', (req: express.Request, res: express.Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Debate Omegle - Random Debate Platform</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0f0f, #1a1a1a);
            color: #eee; margin: 0; padding: 10px;
            min-height: 100vh; display: flex; flex-direction: column;
        }

        .header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 15px 20px; background: rgba(28, 28, 28, 0.9);
            border-radius: 12px; margin-bottom: 20px;
            backdrop-filter: blur(10px); border: 1px solid #333;
        }

        .header h1 {
            margin: 0; font-size: 1.8em; color: #4db6ff;
            display: flex; align-items: center; gap: 10px;
        }

        .stats-container {
            display: flex; gap: 15px; align-items: center;
        }

        .stat-card {
            background: linear-gradient(135deg, rgba(77, 182, 255, 0.1), rgba(77, 182, 255, 0.05));
            border: 1px solid rgba(77, 182, 255, 0.3);
            border-radius: 10px; padding: 12px 16px;
            text-align: center; min-width: 90px;
            transition: all 0.3s ease;
            backdrop-filter: blur(5px);
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(77, 182, 255, 0.2);
            border-color: rgba(77, 182, 255, 0.5);
        }

        .stat-number {
            font-size: 1.4em; font-weight: 700;
            color: #4db6ff; line-height: 1;
            margin-bottom: 4px;
        }

        .stat-label {
            font-size: 0.8em; color: #aaa;
            text-transform: uppercase; letter-spacing: 0.5px;
            font-weight: 500;
        }

        .stat-card.online {
            background: linear-gradient(135deg, rgba(46, 213, 115, 0.15), rgba(46, 213, 115, 0.05));
            border-color: rgba(46, 213, 115, 0.3);
        }

        .stat-card.online .stat-number { color: #2ed573; }

        .stat-card.online:hover {
            box-shadow: 0 8px 20px rgba(46, 213, 115, 0.2);
            border-color: rgba(46, 213, 115, 0.5);
        }

        .stat-card.debates {
            background: linear-gradient(135deg, rgba(255, 107, 107, 0.15), rgba(255, 107, 107, 0.05));
            border-color: rgba(255, 107, 107, 0.3);
        }

        .stat-card.debates .stat-number { color: #ff6b6b; }

        .stat-card.debates:hover {
            box-shadow: 0 8px 20px rgba(255, 107, 107, 0.2);
            border-color: rgba(255, 107, 107, 0.5);
        }

        .stat-card.waiting {
            background: linear-gradient(135deg, rgba(255, 184, 0, 0.15), rgba(255, 184, 0, 0.05));
            border-color: rgba(255, 184, 0, 0.3);
        }

        .stat-card.waiting .stat-number { color: #ffb800; }

        .stat-card.waiting:hover {
            box-shadow: 0 8px 20px rgba(255, 184, 0, 0.2);
            border-color: rgba(255, 184, 0, 0.5);
        }

        .container {
            display: flex; gap: 15px; flex: 1;
            max-width: 1200px; margin: 0 auto; width: 100%;
        }

        .chat-area {
            flex: 1; background: #1c1c1c;
            border-radius: 15px; padding: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.7);
            border: 1px solid #333; display: flex; flex-direction: column;
        }

        #topic {
            text-align: center; margin: 0 0 15px 0; font-weight: bold;
            font-size: 1.1em; color: #4db6ff; padding: 12px;
            background: rgba(77, 182, 255, 0.1); border-radius: 8px;
            border: 1px solid rgba(77, 182, 255, 0.3);
            min-height: 45px; display: flex; align-items: center; justify-content: center;
        }

        #topic.interest-match {
            background: linear-gradient(135deg, rgba(46, 213, 115, 0.15), rgba(46, 213, 115, 0.05));
            border-color: rgba(46, 213, 115, 0.4);
            color: #2ed573;
        }

        #chat {
            background: #222; padding: 15px; height: 400px; overflow-y: auto;
            border-radius: 10px; margin-bottom: 15px; border: 1px solid #333;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; line-height: 1.5;
            flex: 1;
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

        #inputArea {
            display: flex; gap: 10px; margin-bottom: 15px;
        }

        #inputArea input {
            flex: 1; padding: 12px; border: 1px solid #444;
            border-radius: 8px; background: #2a2a2a; color: #eee;
            font-size: 14px; transition: all 0.2s;
        }

        #inputArea input:focus {
            outline: none; border-color: #4db6ff; background: #333;
            box-shadow: 0 0 0 2px rgba(77, 182, 255, 0.2);
        }

        #controls {
            display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
        }

        #controls input {
            flex: 1; min-width: 200px; padding: 12px;
            border: 1px solid #444; border-radius: 8px;
            background: #2a2a2a; color: #eee; font-size: 14px;
        }

        #controls input:focus {
            outline: none; border-color: #4db6ff; background: #333;
            box-shadow: 0 0 0 2px rgba(77, 182, 255, 0.2);
        }

        button {
            padding: 12px 20px; border: none; border-radius: 8px;
            background: #4db6ff; color: white; cursor: pointer;
            font-weight: 600; font-size: 14px; transition: all 0.2s ease;
            white-space: nowrap;
        }

        button:hover:not(:disabled) {
            background: #3da8ef; transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(77, 182, 255, 0.3);
        }

        button:disabled {
            background: #555; color: #999; cursor: not-allowed;
            transform: none; box-shadow: none;
        }

        #skipBtn { background: #ff9500; }
        #skipBtn:hover:not(:disabled) { background: #e6850e; }

        #endBtn { background: #ff4757; }
        #endBtn:hover:not(:disabled) { background: #e73c4e; }

        .status-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #2ed573; margin-right: 8px;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        #chat::-webkit-scrollbar { width: 8px; }
        #chat::-webkit-scrollbar-track { background: #1a1a1a; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb:hover { background: #666; }

        @media (max-width: 768px) {
            .container { flex-direction: column; }
            .header { flex-direction: column; gap: 15px; text-align: center; }
            .stats-container { justify-content: center; flex-wrap: wrap; }
            .stat-card { min-width: 80px; }
            #controls { flex-direction: column; }
            #controls input { min-width: auto; }
            #chat { height: 300px; }
        }

        .stat-number.updating {
            animation: numberPulse 0.5s ease;
        }

        @keyframes numberPulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }

        .interest-hint {
            font-size: 0.9em; color: #aaa; margin-top: 5px;
            text-align: center;
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
            <div id="chat"></div>

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
            <div class="interest-hint">💡 Enter interests to find people with similar hobbies!</div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io({transports: ['websocket', 'polling']});
        const chatEl = document.getElementById('chat');
        const topicEl = document.getElementById('topic');
        const msgBox = document.getElementById('messageBox');
        const sendBtn = document.getElementById('sendBtn');
        const startBtn = document.getElementById('startBtn');
        const skipBtn = document.getElementById('skipBtn');
        const endBtn = document.getElementById('endBtn');
        let currentRoom = null;

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
            msgBox.disabled = true; sendBtn.disabled = true; currentRoom = null;
            topicEl.classList.remove('interest-match');
        }

        startBtn.onclick = () => {
            if (startBtn.textContent === 'Find Debate Partner') {
                const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
                socket.emit('find', { tags });

                if (tags.length > 0) {
                    addMessage('🔎 Searching for someone interested in: ' + tags.join(', ') + '...', 'system');
                } else {
                    addMessage('🔎 Searching for any debate partner...', 'system');
                }

                startBtn.disabled = true; startBtn.textContent = 'Searching...';
                skipBtn.disabled = false; endBtn.disabled = false;
            }
        };

        skipBtn.onclick = () => {
            socket.emit('skip'); chatEl.innerHTML = ''; 
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
            topicEl.classList.remove('interest-match');
            resetUI();
            addMessage('⏭️ Skipped partner. Click "Find Debate Partner" to search again.', 'system');
        };

        endBtn.onclick = () => {
            if (currentRoom) socket.emit('end', { roomId: currentRoom });
            chatEl.innerHTML = ''; 
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
            topicEl.classList.remove('interest-match');
            resetUI();
            addMessage('🏁 Debate ended. Click "Find Debate Partner" for another round.', 'system');
        };

        sendBtn.onclick = () => {
            if (!currentRoom) return;
            const text = msgBox.value.trim();
            if (!text) return;

            addMessage('You: ' + text, 'me');
            socket.emit('message', { roomId: currentRoom, text });
            msgBox.value = '';
        };

        msgBox.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendBtn.click();
        });

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
                addMessage('🎉 Connected to opponent! Start your debate now. Be respectful and have fun!', 'system');
            }

            msgBox.disabled = false; sendBtn.disabled = false;
            msgBox.focus();
        });

        socket.on('msg', ({ from, text }) => {
            addMessage('Opponent: ' + text, 'other');
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

// Graceful shutdown
let isShuttingDown = false;

const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing server gracefully');

  server.close(() => {
    logger.info('HTTP server closed');

    for (const [roomId] of activeRooms) {
      endRoom(roomId, 'Server maintenance');
    }

    io.close(() => {
      logger.info('Socket.IO server closed');

      for (const [roomId] of roomTimers) {
        clearRoomTimer(roomId);
      }

      logger.info('Graceful shutdown completed');
      process.exit(0);
    });
  });

  setTimeout(() => {
    logger.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = parseInt(process.env.PORT || '3000');

server.listen(PORT, () => {
  logger.info({ 
    port: PORT, 
    env: process.env.NODE_ENV || 'development'
  }, '🚀 Production Debate Omegle server started');
});
