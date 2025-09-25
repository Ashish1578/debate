import express from 'express';
import { Matchmaker } from './matchmaker';
import { Logger } from 'pino';

export function setupAPI(app: express.Application, matchmaker: Matchmaker, logger: Logger): void {

  // Stats endpoint for monitoring
  app.get('/api/stats', (req, res) => {
    try {
      const stats = matchmaker.getStats();
      res.json({
        ...stats,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    } catch (error) {
      logger.error('Error getting stats:', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Get available topics
  app.get('/api/topics', (req, res) => {
    try {
      const topics = matchmaker.getTopics();
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
  app.get('/api/health', (req, res) => {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
      environment: process.env.NODE_ENV || 'development'
    };

    res.json(health);
  });

  // Rate limiting info
  app.get('/api/limits', (req, res) => {
    res.json({
      maxConnectionsPerIP: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '10'),
      roomDurationMinutes: parseInt(process.env.ROOM_DURATION_MINUTES || '5'),
      maxMessageLength: 500
    });
  });

  // Error handling for API routes
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
}
