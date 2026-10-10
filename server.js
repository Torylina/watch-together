const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Состояние комнат в памяти: { videoId, playing, time, updatedAt, queue }
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.redirect('/r/' + Math.random().toString(36).slice(2, 8));
});
app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function rid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { videoId: null, playing: false, time: 0, updatedAt: Date.now(), queue: [] });
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
function sendQueue(roomId, room) {
  broadcast(roomId, { type: 'queue', queue: room.queue });
}
// Запустить следующее видео из очереди (первое или выбранное по qid)
function advance(roomId, room, qid) {
  if (!room.queue.length) return;
  const i = qid ? room.queue.findIndex((q) => q.id === qid) : 0;
  if (i < 0) return;
  const [item] = room.queue.splice(i, 1);
  room.videoId = item.videoId;
  room.playing = true;
  room.time = 0;
  room.updatedAt = Date.now();
  broadcast(roomId, { type: 'state', videoId: room.videoId, playing: true, time: 0 });
  sendQueue(roomId, room);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomId = (url.searchParams.get('room') || 'default').slice(0, 32);
  ws.room = roomId;
  const room = getRoom(roomId);

  // Новому участнику сразу отправляем текущее состояние и очередь
  ws.send(JSON.stringify({
    type: 'state', videoId: room.videoId, playing: room.playing, time: currentTime(room)
  }));
  ws.send(JSON.stringify({ type: 'queue', queue: room.queue }));
  sendUsers(roomId);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'state') {
      if (typeof m.videoId === 'string') room.videoId = m.videoId.slice(0, 100);
      room.playing = !!m.playing;
      room.time = Number(m.time) || 0;
      room.updatedAt = Date.now();
      broadcast(roomId, { type: 'state', videoId: room.videoId, playing: room.playing, time: room.time }, ws);
    } else if (m.type === 'chat') {
      const text = String(m.text || '').slice(0, 500);
      const name = String(m.name || 'Аноним').slice(0, 30);
      const id = rid();
      if (text.trim()) broadcast(roomId, { type: 'chat', id, name, text });
    } else if (m.type === 'react') {
      const emoji = String(m.emoji || '').slice(0, 8);
      if (emoji && m.msgId) {
        broadcast(roomId, {
          type: 'react',
          msgId: String(m.msgId).slice(0, 30),
          emoji,
          uid: String(m.uid || '').slice(0, 40),
          on: !!m.on
        });
      }
    } else if (m.type === 'queue_add') {
      const v = String(m.videoId || '').slice(0, 100);
      if (/^(yt|vk):/.test(v) && room.queue.length < 50) {
        room.queue.push({ id: rid(), videoId: v });
        sendQueue(roomId, room);
      }
    } else if (m.type === 'queue_remove') {
      room.queue = room.queue.filter((q) => q.id !== m.qid);
      sendQueue(roomId, room);
    } else if (m.type === 'queue_play') {
      advance(roomId, room, String(m.qid || ''));
    } else if (m.type === 'next') {
      // Видео закончилось. Несколько клиентов пришлют это одновременно —
      // переключаем только если текущее видео ещё то же самое.
      if (m.videoId === room.videoId) advance(roomId, room);
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
