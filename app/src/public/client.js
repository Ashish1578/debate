// Initialize Socket.IO connection
const socket = io({
    transports: ['websocket', 'polling']
});

// DOM elements
const chatEl = document.getElementById('chat');
const topicEl = document.getElementById('topic');
const msgBox = document.getElementById('messageBox');
const sendBtn = document.getElementById('sendBtn');
const startBtn = document.getElementById('startBtn');
const skipBtn = document.getElementById('skipBtn');
const endBtn = document.getElementById('endBtn');
const statsEl = document.getElementById('stats');

let currentRoom = null;

// Helper function to add messages to chat
function addMessage(text, type = 'system') {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${type}`;
    msgDiv.textContent = text;
    chatEl.appendChild(msgDiv);
    chatEl.scrollTop = chatEl.scrollHeight;
}

// Event listeners
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

function resetUI() {
    startBtn.disabled = false;
    skipBtn.disabled = true;
    endBtn.disabled = true;
    msgBox.disabled = true;
    sendBtn.disabled = true;
    currentRoom = null;
}

// Socket event handlers
socket.on('connect', () => {
    addMessage('✅ Connected to Debate Omegle!', 'system');
    updateStats();
});

socket.on('disconnect', () => {
    addMessage('❌ Disconnected. Trying to reconnect...', 'system');
    resetUI();
});

socket.on('system', (msg) => {
    addMessage(msg, 'system');
});

socket.on('matched', ({ roomId, topic, duration }) => {
    currentRoom = roomId;
    chatEl.innerHTML = '';
    const durationMin = Math.floor(duration / 1000 / 60);
    topicEl.textContent = `🗣 Debate Topic: ${topic} (${durationMin}min)`;
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
    addMessage(`💬 Debate ended: ${reason}`, 'system');
    addMessage('Thanks for debating! Click "Find Debate Partner" for another round.', 'system');
    resetUI();
    topicEl.textContent = '';
});

// Update stats periodically
function updateStats() {
    fetch('/api/stats')
        .then(res => res.json())
        .then(data => {
            statsEl.textContent = `${data.totalConnections} online • ${data.activeRooms} active debates • ${data.waitingUsers} waiting`;
        })
        .catch(() => {
            statsEl.textContent = 'Stats unavailable';
        });
}

// Update stats every 10 seconds
setInterval(updateStats, 10000);

// Initialize
addMessage('Welcome to Debate Omegle! Enter your interests (optional) and click "Find Debate Partner" to start.', 'system');
updateStats();