import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';
import { Matchmaker } from './system/matchmaker';
import { setupAPI } from './system/api';

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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO setup
const io = new IOServer(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Initialize matchmaker
const matchmaker = new Matchmaker(io, logger);

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);

  socket.on('find', async ({ tags = [] }) => {
    try {
      await matchmaker.handleFindMatch(socket, tags);
    } catch (error) {
      logger.error('Error finding match:', error);
      socket.emit('system', 'Error finding match. Please try again.');
    }
  });

  socket.on('message', async ({ roomId, text }) => {
    try {
      await matchmaker.handleMessage(socket, roomId, text);
    } catch (error) {
      logger.error('Error handling message:', error);
    }
  });

  socket.on('skip', async () => {
    try {
      await matchmaker.skipDebate(socket);
    } catch (error) {
      logger.error('Error skipping debate:', error);
    }
  });

  socket.on('end', async ({ roomId }) => {
    try {
      await matchmaker.endDebate(socket, roomId);
    } catch (error) {
      logger.error('Error ending debate:', error);
    }
  });

  socket.on('disconnect', async () => {
    logger.info(`User disconnected: ${socket.id}`);
    try {
      await matchmaker.handleDisconnect(socket);
    } catch (error) {
      logger.error('Error handling disconnect:', error);
    }
  });
});

// Setup API routes
setupAPI(app, matchmaker, logger);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
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
  logger.info('Running in memory-only mode (no Redis)');
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
