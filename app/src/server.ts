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

// Simple in-memory storage
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
      const duration = 5 * 60 * 1000;

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

// Serve static files - try multiple paths for Render compatibility
const staticPaths = [
  path.join(__dirname, '../'),
  path.join(__dirname, '../../'),
  path.join(__dirname, '../public'),
  path.join(__dirname, '../../public'),
  __dirname,
  path.join(process.cwd(), 'app'),
  process.cwd()
];

staticPaths.forEach(staticPath => {
  app.use(express.static(staticPath));
  logger.info(`Added static path: ${staticPath}`);
});

// Root route with embedded HTML as fallback
app.get('/', (req: express.Request, res: express.Response) => {
  const possiblePaths = [
    path.join(__dirname, '../index.html'),
    path.join(__dirname, '../../index.html'),
    path.join(__dirname, '../public/index.html'),
    path.join(__dirname, '../../public/index.html'),
    path.join(__dirname, 'index.html'),
    path.join(process.cwd(), 'app/index.html'),
    path.join(process.cwd(), 'index.html')
  ];

  logger.info(`Trying to serve index.html from paths: ${possiblePaths.join(', ')}`);

  // Try each path
  const tryNextPath = (index: number): void => {
    if (index >= possiblePaths.length) {
      // If no file found, serve embedded HTML
      logger.warn('No index.html found, serving embedded HTML');
      res.send(getEmbeddedHTML());
      return;
    }

    const currentPath = possiblePaths[index];
    logger.info(`Trying path: ${currentPath}`);

    res.sendFile(currentPath, (err?: Error) => {
      if (err) {
        logger.warn(`Failed to serve from ${currentPath}:`, err.message);
        tryNextPath(index + 1);
      } else {
        logger.info(`Successfully served from ${currentPath}`);
      }
    });
  };

  tryNextPath(0);
});

// Embedded HTML as ultimate fallback
function getEmbeddedHTML(): string {
  return `<!DOCTYPE html>
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
            color: #eee;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 10px;
        }
        #app {
            width: 100%;
            max-width: 650px;
            background: #1c1c1c;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.7);
            border: 1px solid #333;
        }
        h1 { text-align: center; margin: 0 0 10px 0; color: #fff; font-size: 2.2em; }
        #controls, #inputArea { display: flex; gap: 10px; margin: 15px 0; flex-wrap: wrap; }
        #controls input, #inputArea input { flex: 1; min-width: 200px; }
        input[type="text"] {
            padding: 12px; border: 1px solid #444; border-radius: 8px;
            background: #2a2a2a; color: #eee; font-size: 14px;
        }
        input[type="text"]:focus { outline: none; border-color: #4db6ff; background: #333; }
        button {
            padding: 12px 18px; border: none; border-radius: 8px; background: #4db6ff;
            color: white; cursor: pointer; font-weight: 600; font-size: 14px;
            transition: all 0.2s ease;
        }
        button:hover:not(:disabled) { background: #3da8ef; transform: translateY(-1px); }
        button:disabled { background: #555; color: #999; cursor: not-allowed; transform: none; }
        #skipBtn { background: #ff9500; }
        #skipBtn:hover:not(:disabled) { background: #e6850e; }
        #endBtn { background: #ff4757; }
        #endBtn:hover:not(:disabled) { background: #e73c4e; }
        #chat {
            background: #222; padding: 15px; height: 350px; overflow-y: auto;
            border-radius: 10px; margin-bottom: 15px; border: 1px solid #333;
            font-family: monospace; line-height: 1.4;
        }
        .msg { margin: 8px 0; padding: 6px 10px; border-radius: 6px; word-wrap: break-word; }
        .msg.me { color: #4db6ff; background: rgba(77, 182, 255, 0.1); border-left: 3px solid #4db6ff; }
        .msg.other { color: #ff7a7a; background: rgba(255, 122, 122, 0.1); border-left: 3px solid #ff7a7a; }
        .msg.system { color: #aaa; font-style: italic; text-align: center; background: rgba(170, 170, 170, 0.05); border-radius: 20px; }
        #topic { text-align: center; margin: 15px 0; font-weight: bold; font-size: 1.1em; color: #4db6ff; padding: 12px; background: rgba(77, 182, 255, 0.1); border-radius: 8px; border: 1px solid rgba(77, 182, 255, 0.3); }
    </style>
</head>
<body>
    <div id="app">
        <h1>🗣️ Debate Omegle</h1>
        <p style="text-align: center; color: #aaa; margin-bottom: 20px;">Connect with strangers for random debates on interesting topics!</p>
        <div id="topic"></div>
        <div id="chat"></div>
        <div id="inputArea">
            <input type="text" id="messageBox" placeholder="Type your argument..." disabled>
            <button id="sendBtn" disabled>Send</button>
        </div>
        <div id="controls">
            <input type="text" id="tags" placeholder="Enter interests (optional): cats, politics, sports">
            <button id="startBtn">Find Debate Partner</button>
            <button id="skipBtn" disabled>Skip</button>
            <button id="endBtn" disabled>End Debate</button>
        </div>
        <div style="text-align: center; margin-top: 15px; color: #666; font-size: 12px;">
            <p>🔥 <span id="stats">Loading...</span> • Be respectful and have fun!</p>
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
        const statsEl = document.getElementById('stats');
        let currentRoom = null;

        function addMessage(text, type = 'system') {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'msg ' + type;
            msgDiv.textContent = text;
            chatEl.appendChild(msgDiv);
            chatEl.scrollTop = chatEl.scrollHeight;
        }

        function resetUI() {
            startBtn.disabled = false;
            skipBtn.disabled = true;
            endBtn.disabled = true;
            msgBox.disabled = true;
            sendBtn.disabled = true;
            currentRoom = null;
        }

        startBtn.onclick = () => {
            const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
            socket.emit('find', { tags });
            addMessage('🔎 Searching for a partner...', 'system');
            startBtn.disabled = true;
            skipBtn.disabled = false;
            endBtn.disabled = false;
        };

        skipBtn.onclick = () => {
            socket.emit('skip');
            chatEl.innerHTML = '';
            topicEl.textContent = '';
            resetUI();
            addMessage('Skipped. Click "Find Debate Partner" to search again.', 'system');
        };

        endBtn.onclick = () => {
            if (currentRoom) socket.emit('end', { roomId: currentRoom });
            chatEl.innerHTML = '';
            topicEl.textContent = '';
            resetUI();
            addMessage('Debate ended. Click "Find Debate Partner" to search again.', 'system');
        };

        sendBtn.onclick = () => {
            if (!currentRoom) return;
            const text = msgBox.value.trim();
            if (!text) return;
            socket.emit('message', { roomId: currentRoom, text });
            addMessage('You: ' + text, 'me');
            msgBox.value = '';
        };

        msgBox.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendBtn.click();
        });

        socket.on('connect', () => {
            addMessage('✅ Connected to Debate Omegle!', 'system');
            fetch('/api/stats').then(res => res.json()).then(data => {
                statsEl.textContent = data.totalConnections + ' online • ' + data.activeRooms + ' active debates • ' + data.waitingUsers + ' waiting';
            }).catch(() => {
                statsEl.textContent = 'Stats unavailable';
            });
        });

        socket.on('disconnect', () => {
            addMessage('❌ Disconnected. Trying to reconnect...', 'system');
            resetUI();
        });

        socket.on('system', (msg) => addMessage(msg, 'system'));

        socket.on('matched', ({ roomId, topic, duration }) => {
            currentRoom = roomId;
            chatEl.innerHTML = '';
            const durationMin = Math.floor(duration / 1000 / 60);
            topicEl.textContent = '🗣 Debate Topic: ' + topic + ' (' + durationMin + 'min)';
            msgBox.disabled = false;
            sendBtn.disabled = false;
            addMessage('🎯 Connected! Start your debate now. Be respectful!', 'system');
            msgBox.focus();
        });

        socket.on('msg', ({ from, text }) => {
            const type = from === socket.id ? 'me' : 'other';
            addMessage((type === 'me' ? 'You' : 'Opponent') + ': ' + text, type);
        });

        socket.on('room_ended', ({ reason }) => {
            addMessage('💬 Debate ended: ' + reason, 'system');
            addMessage('Thanks for debating! Click "Find Debate Partner" for another round.', 'system');
            resetUI();
            topicEl.textContent = '';
        });

        addMessage('Welcome to Debate Omegle! Enter your interests (optional) and click "Find Debate Partner" to start.', 'system');
    </script>
</body>
</html>`;
}

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`🚀 Debate Omegle server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info('Static file paths configured for Render deployment');
});

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
