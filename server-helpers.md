# Server Operations and Scaling Guide

## 🏗️ Architecture Overview

### Core Components
- **Express Server**: REST API and static file serving
- **Socket.IO**: Real-time WebSocket communication
- **Redis**: Distributed state management and matchmaking
- **TypeScript**: Type-safe development
- **Docker**: Containerized deployment

### Data Flow
1. User connects via WebSocket
2. Matchmaker queues user with preferences
3. Redis handles distributed matching logic
4. Real-time chat established between matched users
5. Automatic cleanup after debate duration

## 📈 Scaling Considerations

### Horizontal Scaling
```yaml
# docker-compose.yml
services:
  app:
    deploy:
      replicas: 3
    environment:
      - REDIS_URL=redis://redis-cluster:6379
```

### Load Balancing
- nginx handles WebSocket upgrade correctly
- Sticky sessions not required (Redis manages state)
- Multiple app instances share Redis backend

### Database Scaling
```bash
# Redis Cluster setup
redis-cli --cluster create \
  redis-1:6379 redis-2:6379 redis-3:6379 \
  --cluster-replicas 1
```

## 🛡️ Security Implementation

### Input Validation
- Message length: max 500 characters
- Tag validation: alphanumeric only
- Rate limiting: 10 requests/second per IP
- XSS prevention: text sanitization

### Network Security
```nginx
# Rate limiting configuration
limit_req_zone $binary_remote_addr zone=websocket:10m rate=50r/s;
limit_req zone=websocket burst=100 nodelay;
```

### Environment Security
- Secrets in environment variables
- No hardcoded credentials
- CORS restricted in production
- Security headers via Helmet.js

## 📊 Monitoring and Observability  

### Key Metrics to Track
```typescript
// Available via /api/stats
interface Stats {
  activeRooms: number;
  waitingUsers: number;
  totalConnections: number;
  averageWaitTime: number;
  roomsPerHour: number;
  messageRate: number;
}
```

### Health Checks
```bash
# Kubernetes liveness probe
curl -f http://localhost:3000/health

# Application metrics
curl http://localhost:3000/api/stats
```

### Log Management
```typescript
// Structured logging with Pino
logger.info('Room created', {
  roomId: 'room_123',
  users: ['user1', 'user2'],
  topic: 'cats vs dogs'
});
```

## ⚡ Performance Optimization

### Memory Management
```typescript
// Automatic cleanup of expired rooms
setInterval(() => {
  this.cleanupExpiredRooms();
}, 60000); // Every minute
```

### Connection Optimization
```typescript
// Socket.IO configuration
const io = new IOServer(server, {
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});
```

### Redis Optimization
```bash
# redis.conf settings
maxmemory 2gb
maxmemory-policy allkeys-lru
tcp-keepalive 300
```

## 🔄 Deployment Strategies

### Zero-Downtime Deployment
```bash
# Rolling deployment
docker-compose up -d --scale app=2
docker-compose stop app_1
docker-compose rm app_1
docker-compose up -d --scale app=3
```

### Blue-Green Deployment
```yaml
# Two identical environments
version: '3.8'
services:
  app-blue:
    # Current production
  app-green:
    # New version for testing
  nginx:
    # Switch upstream target
```

## 🔍 Debugging and Troubleshooting

### Common Issues

1. **Memory Leaks**
   ```bash
   # Monitor memory usage
   docker stats debate-omegle_app_1

   # Heap dump analysis
   node --inspect dist/server.js
   ```

2. **Redis Connection Issues**
   ```typescript
   // Connection monitoring
   redis.on('error', (err) => {
     logger.error('Redis connection error', err);
     // Implement reconnection logic
   });
   ```

3. **WebSocket Disconnections**
   ```typescript
   // Client reconnection logic
   socket.on('disconnect', (reason) => {
     if (reason === 'io server disconnect') {
       socket.connect();
     }
   });
   ```

### Debug Mode
```bash
# Enable verbose logging
DEBUG=socket.io:* NODE_ENV=development npm run dev

# Redis debugging
redis-cli monitor
```

## 🚀 Advanced Features

### Geographic Load Balancing
- Deploy to multiple regions
- Route users to nearest server
- Cross-region Redis replication

### A/B Testing Framework
```typescript
// Feature flags
const features = {
  newMatchingAlgorithm: Math.random() < 0.5,
  enhancedUI: process.env.FEATURE_ENHANCED_UI === 'true'
};
```

### Analytics Integration
```typescript
// Event tracking
analytics.track('debate_started', {
  roomId,
  topic,
  userCount: 2,
  timestamp: Date.now()
});
```

## 🔧 Maintenance Tasks

### Regular Maintenance
```bash
# Weekly tasks
docker system prune -f
redis-cli FLUSHDB expired_keys
npm audit fix

# Monthly tasks  
docker-compose pull
docker-compose up -d --build
```

### Backup Strategy
```bash
# Redis backup
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb /backups/

# Application logs
tar -czf logs-$(date +%Y%m%d).tar.gz logs/
```

### Monitoring Scripts
```bash
#!/bin/bash
# check_health.sh
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
if [ $response != "200" ]; then
  echo "Health check failed: $response"
  # Send alert
fi
```
