import express from 'express';
import { Logger } from 'pino';

// Simple stats interface for memory-only mode
interface SimpleStats {
  activeRooms: number;
  waitingUsers: number;
  totalConnections: number;
  timestamp: string;
  uptime: number;
}

export function setupAPI(app: express.Application, getStats: () => SimpleStats, getTopics: () => string[], logger: Logger): void {

  // Stats endpoint for monitoring
  app.get('/api/stats', (req: express.Request, res: express.Response) => {
    try {
      const stats = getStats();
      res.json(stats);
    } catch (error) {
      logger.error('Error getting stats:', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Get available topics
  app.get('/api/topics', (req: express.Request, res: express.Response) => {
    try {
      const topics = getTopics();
      res.json({ 
        topics,
        count: topics.length 
      });
    } catch (error) {
      logger.error('Error getting topics:', error);
      res.status(500).json({ error: 'Failed to get topics' });
    }
  });

  // Health check with detailed info
  app.get('/api/health', (req: express.Request, res: express.Response) => {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
      environment: process.env.NODE_ENV || 'development',
      mode: 'memory-only'
    };

    res.json(health);
  });

  // Rate limiting info
  app.get('/api/limits', (req: express.Request, res: express.Response) => {
    res.json({
      maxConnectionsPerIP: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '10'),
      roomDurationMinutes: parseInt(process.env.ROOM_DURATION_MINUTES || '5'),
      maxMessageLength: 500,
      mode: 'memory-only'
    });
  });

  // Error handling for API routes
  app.use('/api/*', (req: express.Request, res: express.Response) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
}
