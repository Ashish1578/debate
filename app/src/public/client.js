
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
};


endBtn.onclick = () => {
if (currentRoom) socket.emit('end', { roomId: currentRoom });
chatEl.innerHTML = '';
topicEl.textContent = '';
startBtn.disabled = false;
skipBtn.disabled = true;
endBtn.disabled = true;
msgBox.disabled = true;
sendBtn.disabled = true;
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


socket.on('system', (msg) => addMessage(msg, 'system'));


socket.on('matched', ({ roomId, side, topic, duration }) => {
currentRoom = roomId;
chatEl.innerHTML = '';
topicEl.textContent = '🗣 Debate Topic: ' + topic + ` (Time: ${duration}s)`;
msgBox.disabled = false;
sendBtn.disabled = false;
addMessage('Connected! Debate starts now.', 'system');
});


socket.on('msg', ({ from, text }) => {
const type = from === socket.id ? 'me' : 'other';
addMessage((type === 'me' ? 'You' : 'Stranger') + ': ' + text, type);
});


socket.on('room_ended', ({ reason }) => {
addMessage('Room ended: ' + reason, 'system');
currentRoom = null;
msgBox.disabled = true;
sendBtn.disabled = true;
});
