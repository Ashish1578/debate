import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import Redis from 'ioredis';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const logger = pino({ level: 'info' });
const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

const io = new IOServer(server, { 
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  } 
});

// Redis for queue management
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Debate topics pool
const DEBATE_TOPICS = [
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

// In-memory state
const waitingUsers = new Map<string, { socketId: string, tags: string[] }>();
const activeRooms = new Map<string, { users: string[], topic: string, startTime: number }>();
const userRoomMap = new Map<string, string>();

function getRandomTopic(): string {
  return DEBATE_TOPICS[Math.floor(Math.random() * DEBATE_TOPICS.length)];
}

function generateRoomId(): string {
  return `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function findMatch(userId: string, userTags: string[]): string | null {
  for (const [waitingId, waitingData] of waitingUsers.entries()) {
    if (waitingId === userId) continue;
    
    // Check for tag match
    const hasCommonTags = userTags.some(tag => 
      waitingData.tags.some(wtag => 
        wtag.toLowerCase() === tag.toLowerCase()
      )
    );
    
    if (hasCommonTags || (userTags.length === 0 && waitingData.tags.length === 0)) {
      return waitingId;
    }
  }
  
  // If no tag match, return any waiting user
  for (const [waitingId] of waitingUsers.entries()) {
    if (waitingId !== userId) return waitingId;
  }
  
  return null;
}

io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);
  
  socket.on('find', ({ tags = [] }) => {
    logger.info(`User ${socket.id} searching with tags: ${tags.join(', ')}`);
    
    // Check if already in a room
    if (userRoomMap.has(socket.id)) {
      socket.emit('system', 'You are already in a debate!');
      return;
    }
    
    // Try to find a match
    const matchId = findMatch(socket.id, tags);
    
    if (matchId) {
      // Create room and match users
      const roomId = generateRoomId();
      const topic = getRandomTopic();
      const duration = 300; // 5 minutes
      
      activeRooms.set(roomId, {
        users: [socket.id, matchId],
        topic,
        startTime: Date.now()
      });
      
      userRoomMap.set(socket.id, roomId);
      userRoomMap.set(matchId, roomId);
      
      // Remove from waiting
      waitingUsers.delete(matchId);
      
      // Join both users to room
      socket.join(roomId);
      io.sockets.sockets.get(matchId)?.join(roomId);
      
      // Notify both users
      io.to(roomId).emit('matched', {
        roomId,
        topic,
        duration
      });
      
      logger.info(`Matched ${socket.id} and ${matchId} in room ${roomId}`);
    } else {
      // Add to waiting queue
      waitingUsers.set(socket.id, { socketId: socket.id, tags });
      socket.emit('system', 'Waiting for an opponent...');
    }
  });
  
  socket.on('message', ({ roomId, text }) => {
    if (!roomId || !activeRooms.has(roomId)) return;
    if (!userRoomMap.get(socket.id) === roomId) return;
    
    // Broadcast message to room
    io.to(roomId).emit('msg', {
      from: socket.id,
      text,
      timestamp: Date.now()
    });
  });
  
  socket.on('skip', () => {
    const roomId = userRoomMap.get(socket.id);
    if (!roomId) {
      // If waiting, remove from queue
      waitingUsers.delete(socket.id);
      socket.emit('system', 'Search cancelled');
      return;
    }
    
    // End current room
    endRoom(roomId, 'User skipped');
    
    // Auto-search for new match
    socket.emit('system', 'Looking for a new debate partner...');
  });
  
  socket.on('end', ({ roomId }) => {
    if (!roomId || !activeRooms.has(roomId)) return;
    endRoom(roomId, 'User ended the debate');
  });
  
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
    
    // Remove from waiting queue
    waitingUsers.delete(socket.id);
    
    // Check if in a room
    const roomId = userRoomMap.get(socket.id);
    if (roomId) {
      endRoom(roomId, 'User disconnected');
    }
  });
  
  function endRoom(roomId: string, reason: string) {
    const room = activeRooms.get(roomId);
    if (!room) return;
    
    // Notify all users in room
    io.to(roomId).emit('room_ended', { reason });
    
    // Clean up
    room.users.forEach(userId => {
      userRoomMap.delete(userId);
      const userSocket = io.sockets.sockets.get(userId);
      if (userSocket) {
        userSocket.leave(roomId);
      }
    });
    
    activeRooms.delete(roomId);
    logger.info(`Room ${roomId} ended: ${reason}`);
  }
});

// API endpoints for stats (Phase 2/3)
app.get('/api/stats', (req, res) => {
  res.json({
    activeRooms: activeRooms.size,
    waitingUsers: waitingUsers.size,
    totalUsers: io.sockets.sockets.size
  });
});

app.get('/api/topics', (req, res) => {
  res.json({ topics: DEBATE_TOPICS });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Debate Omegle server running on port ${PORT}`);
});