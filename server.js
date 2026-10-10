const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Состояние комнат в памяти: { videoId, playing, time, updatedAt }
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.redirect('/r/' + Math.random().toString(36).slice(2, 8));
});
app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { videoId: null, playing: false, time: 0, updatedAt: Date.now() });
  return rooms.get(id);
}
function currentTime(r) {
  return r.playing ? r.time + (Date.now() - r.updatedAt) / 1000 : r.time;
}
function broadcast(roomId, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.room === roomId && c !== except) c.send(data);
  }
}
function sendUsers(roomId) {
  let n = 0;
  for (const c of wss.clients) if (c.readyState === 1 && c.room === roomId) n++;
  broadcast(roomId, { type: 'users', count: n });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomId = (url.searchParams.get('room') || 'default').slice(0, 32);
  ws.room = roomId;
  const room = getRoom(roomId);

  // Новому участнику сразу отправляем текущее состояние
  ws.send(JSON.stringify({
    type: 'state', videoId: room.videoId, playing: room.playing, time: currentTime(room)
  }));
  sendUsers(roomId);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'state') {
      if (typeof m.videoId === 'string') room.videoId = m.videoId.slice(0, 20);
      room.playing = !!m.playing;
      room.time = Number(m.time) || 0;
      room.updatedAt = Date.now();
      broadcast(roomId, { type: 'state', videoId: room.videoId, playing: room.playing, time: room.time }, ws);
    } else if (m.type === 'chat') {
      const text = String(m.text || '').slice(0, 500);
      const name = String(m.name || 'Аноним').slice(0, 30);
      if (text.trim()) broadcast(roomId, { type: 'chat', name, text });
    }
  });

  ws.on('close', () => {
    sendUsers(roomId);
    let left = 0;
    for (const c of wss.clients) if (c.room === roomId) left++;
    if (left === 0) setTimeout(() => {
      let any = false;
      for (const c of wss.clients) if (c.room === roomId) any = true;
      if (!any) rooms.delete(roomId);
    }, 60000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('http://localhost:' + PORT));
