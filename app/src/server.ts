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
  "Should robots have rights?",
  "Is social media good or bad for society?",
  "Should we colonize Mars?",
  "Is artificial intelligence a threat to humanity?",
  "Should college be free?",
  "Is remote work better than office work?"
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

    socket.to(roomId).emit('msg', {
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
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/topics', (req: express.Request, res: express.Response) => {
  res.json({ topics: DEBATE_TOPICS, count: DEBATE_TOPICS.length });
});

app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mode: 'memory-only'
  });
});

// MAIN ROUTE - With horizontal stat cards
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

        /* Header */
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

        /* Stats Cards Container */
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

        /* Different colors for each stat */
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

        /* Main container */
        .container {
            display: flex; gap: 15px; flex: 1;
            max-width: 1200px; margin: 0 auto; width: 100%;
        }

        /* Chat area */
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

        /* Input area */
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

        /* Controls */
        #controls {
            display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
        }

        #controls input {
            flex: 1; min-width: 200px; padding: 12px;
            border: 1px solid #444; border-radius: 8px;
            background: #2a2a2a; color: #eee; font-size: 14px;
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

        /* Status indicator */
        .status-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #2ed573; margin-right: 8px;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        /* Scrollbar styling */
        #chat::-webkit-scrollbar { width: 8px; }
        #chat::-webkit-scrollbar-track { background: #1a1a1a; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
        #chat::-webkit-scrollbar-thumb:hover { background: #666; }

        /* Responsive design */
        @media (max-width: 768px) {
            .container { flex-direction: column; }
            .header { flex-direction: column; gap: 15px; text-align: center; }
            .stats-container { justify-content: center; flex-wrap: wrap; }
            .stat-card { min-width: 80px; }
            #controls { flex-direction: column; }
            #controls input { min-width: auto; }
            #chat { height: 300px; }
        }

        /* Update animation for stats */
        .stat-number.updating {
            animation: numberPulse 0.5s ease;
        }

        @keyframes numberPulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
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
                <input type="text" id="tags" placeholder="Enter interests: cats, politics, sports, gaming..." maxlength="100">
                <button id="startBtn">Find Debate Partner</button>
                <button id="skipBtn" disabled>Skip Partner</button>
                <button id="endBtn" disabled>End Debate</button>
            </div>
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
        const onlineEl = document.getElementById('online');
        const debatesEl = document.getElementById('debates');
        const waitingEl = document.getElementById('waiting');
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
        }

        function animateStatUpdate(element, newValue) {
            if (element.textContent !== newValue.toString()) {
                element.classList.add('updating');
                element.textContent = newValue;
                setTimeout(() => element.classList.remove('updating'), 500);
            }
        }

        function updateStats() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    animateStatUpdate(onlineEl, data.totalConnections);
                    animateStatUpdate(debatesEl, data.activeRooms);
                    animateStatUpdate(waitingEl, data.waitingUsers);
                })
                .catch(err => console.log('Stats update failed:', err));
        }

        startBtn.onclick = () => {
            if (startBtn.textContent === 'Find Debate Partner') {
                const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
                socket.emit('find', { tags });
                addMessage('🔎 Searching for debate partner...', 'system');
                startBtn.disabled = true; startBtn.textContent = 'Searching...';
                skipBtn.disabled = false; endBtn.disabled = false;
            }
        };

        skipBtn.onclick = () => {
            socket.emit('skip'); chatEl.innerHTML = ''; 
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
            resetUI();
            addMessage('⏭️ Skipped partner. Click "Find Debate Partner" to search again.', 'system');
        };

        endBtn.onclick = () => {
            if (currentRoom) socket.emit('end', { roomId: currentRoom });
            chatEl.innerHTML = ''; 
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
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
            updateStats();
        });

        socket.on('disconnect', () => { 
            addMessage('❌ Disconnected. Reconnecting...', 'system'); 
            resetUI();
        });

        socket.on('system', (msg) => addMessage(msg, 'system'));

        socket.on('matched', ({ roomId, topic, duration }) => {
            currentRoom = roomId; chatEl.innerHTML = '';
            const durationMin = Math.floor(duration / 1000 / 60);
            topicEl.innerHTML = '🎯 <strong>Debate Topic:</strong> ' + topic + ' <small>(' + durationMin + ' min)</small>';
            msgBox.disabled = false; sendBtn.disabled = false;
            addMessage('🎉 Connected to opponent! Start your debate now. Be respectful and have fun!', 'system');
            msgBox.focus();
            updateStats();
        });

        socket.on('msg', ({ from, text }) => {
            addMessage('Opponent: ' + text, 'other');
        });

        socket.on('room_ended', ({ reason }) => {
            addMessage('💬 Debate ended: ' + reason, 'system');
            addMessage('Thanks for the great debate! Click "Find Debate Partner" for another round.', 'system');
            resetUI(); 
            topicEl.textContent = 'Connect with strangers for random debates on interesting topics!';
            updateStats();
        });

        // Update stats every 3 seconds
        setInterval(updateStats, 3000);

        // Welcome message
        addMessage('Welcome to Debate Omegle! 🎉', 'system');
        addMessage('Enter your interests (optional) and click "Find Debate Partner" to start debating with strangers worldwide.', 'system');

        // Initial stats load
        updateStats();
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Debate Omegle running on port ${PORT}`);
  logger.info('✅ Updated with horizontal stat cards!');
});
