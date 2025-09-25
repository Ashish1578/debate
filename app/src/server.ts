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
  contentSecurityPolicy: false, // Allow inline scripts for Socket.IO
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// IMPORTANT: Serve static files from the correct path
// In production, files are in the same directory as the compiled server
app.use(express.static(path.join(__dirname, '../public')));

// Also serve from current directory as fallback
app.use(express.static(__dirname));

// Type definitions
interface WaitingUser {
  socketId: string;
  tags: string[];
}

interface ActiveRoom {
  users: string[];
  topic: string;
  startTime: number;
}

// Simple in-memory storage for this deployment
const waitingUsers = new Map<string, WaitingUser>();
const activeRooms = new Map<string, ActiveRoom>();
const userRoomMap = new Map<string, string>();

// Debate topics
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
  "Should robots have rights?"
];

function getRandomTopic(): string {
  return DEBATE_TOPICS[Math.floor(Math.random() * DEBATE_TOPICS.length)];
}

function generateRoomId(): string {
  return `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function findMatch(userId: string, userTags: string[]): string | null {
  for (const [waitingId, waitingData] of waitingUsers.entries()) {
    if (waitingId === userId) continue;

    const hasCommonTags = userTags.some((tag: string) =>
      waitingData.tags.some((wtag: string) =>
        wtag.toLowerCase() === tag.toLowerCase()
      )
    );

    if (hasCommonTags || (userTags.length === 0 && waitingData.tags.length === 0)) {
      return waitingId;
    }
  }

  for (const [waitingId] of waitingUsers.entries()) {
    if (waitingId !== userId) return waitingId;
  }

  return null;
}

// Socket.IO setup
const io = new IOServer(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);

  socket.on('find', ({ tags = [] }: { tags?: string[] }) => {
    logger.info(`User ${socket.id} searching with tags: ${tags.join(', ')}`);

    if (userRoomMap.has(socket.id)) {
      socket.emit('system', 'You are already in a debate!');
      return;
    }

    const matchId = findMatch(socket.id, tags);

    if (matchId) {
      const roomId = generateRoomId();
      const topic = getRandomTopic();
      const duration = 5 * 60 * 1000; // 5 minutes

      activeRooms.set(roomId, {
        users: [socket.id, matchId],
        topic,
        startTime: Date.now()
      });

      userRoomMap.set(socket.id, roomId);
      userRoomMap.set(matchId, roomId);

      waitingUsers.delete(matchId);

      socket.join(roomId);
      io.sockets.sockets.get(matchId)?.join(roomId);

      io.to(roomId).emit('matched', {
        roomId,
        topic,
        duration
      });

      logger.info(`Matched ${socket.id} and ${matchId} in room ${roomId}`);

      setTimeout(() => {
        endRoom(roomId, 'Time expired');
      }, duration);

    } else {
      waitingUsers.set(socket.id, { socketId: socket.id, tags });
      socket.emit('system', 'Waiting for an opponent...');
    }
  });

  socket.on('message', ({ roomId, text }: { roomId: string; text: string }) => {
    if (!roomId || !activeRooms.has(roomId)) return;
    if (userRoomMap.get(socket.id) !== roomId) return;

    if (!text || text.trim().length === 0 || text.length > 500) return;

    io.to(roomId).emit('msg', {
      from: socket.id,
      text: text.trim(),
      timestamp: Date.now()
    });
  });

  socket.on('skip', () => {
    const roomId = userRoomMap.get(socket.id);

    if (!roomId) {
      waitingUsers.delete(socket.id);
      socket.emit('system', 'Search cancelled');
      return;
    }

    endRoom(roomId, 'User skipped');
  });

  socket.on('end', ({ roomId }: { roomId: string }) => {
    if (!roomId || !activeRooms.has(roomId)) return;
    endRoom(roomId, 'User ended the debate');
  });

  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);

    waitingUsers.delete(socket.id);

    const roomId = userRoomMap.get(socket.id);
    if (roomId) {
      endRoom(roomId, 'User disconnected');
    }
  });
});

function endRoom(roomId: string, reason: string): void {
  const room = activeRooms.get(roomId);
  if (!room) return;

  io.to(roomId).emit('room_ended', { reason });

  room.users.forEach((userId: string) => {
    userRoomMap.delete(userId);
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.leave(roomId);
    }
  });

  activeRooms.delete(roomId);
  logger.info(`Room ${roomId} ended: ${reason}`);
}

// API endpoints
app.get('/api/stats', (req: express.Request, res: express.Response) => {
  res.json({
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalConnections: io.sockets.sockets.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/topics', (req: express.Request, res: express.Response) => {
  res.json({ topics: DEBATE_TOPICS });
});

app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Root route that serves the main HTML file
app.get('/', (req: express.Request, res: express.Response) => {
  const indexPath = path.join(__dirname, 'index.html');
  logger.info(`Serving index from: ${indexPath}`);
  res.sendFile(indexPath, (err?: Error) => {
    if (err) {
      logger.error('Error serving index.html:', err);
      res.status(404).send('<h1>Debate Omegle</h1><p>Frontend files not found. Please check deployment.</p>');
    }
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`🚀 Debate Omegle server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Static files served from: ${path.join(__dirname, '../public')} and ${__dirname}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});
