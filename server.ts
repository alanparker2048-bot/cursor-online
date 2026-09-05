import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

interface Room {
  p1: WebSocket | null;
  p2: WebSocket | null;
  createdAt: number;
}

const PORT = 3000;
const app = express();
const server = http.createServer(app);

// WebSocket 房间管理器: roomId => Room
const rooms = new Map<string, Room>();

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  let curRoom: string | null = null;
  let curRole: 'p1' | 'p2' | null = null;
  let isAlive = true;

  ws.on('pong', () => {
    isAlive = true;
  });

  ws.on('message', (msgData: string | Buffer) => {
    try {
      const msgStr = msgData.toString();
      const data = JSON.parse(msgStr);

      if (data.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', t: data.t }));
        }
        return;
      }

      if (data.type === 'join') {
        const roomId = (data.roomId || '888').trim();
        curRoom = roomId;

        if (!rooms.has(roomId)) {
          // 作为 P1 房主
          curRole = 'p1';
          rooms.set(roomId, { p1: ws, p2: null, createdAt: Date.now() });
          ws.send(JSON.stringify({ type: 'init', role: 'p1', roomId }));
        } else {
          const r = rooms.get(roomId)!;
          if (!r.p2) {
            // 作为 P2 加入
            curRole = 'p2';
            r.p2 = ws;
            ws.send(JSON.stringify({ type: 'init', role: 'p2', roomId }));
            // 通知双方游戏开始
            if (r.p1 && r.p1.readyState === WebSocket.OPEN) {
              r.p1.send(JSON.stringify({ type: 'start' }));
            }
            if (r.p2 && r.p2.readyState === WebSocket.OPEN) {
              r.p2.send(JSON.stringify({ type: 'start' }));
            }
          } else if (!r.p1) {
            // P1 断线重连
            curRole = 'p1';
            r.p1 = ws;
            ws.send(JSON.stringify({ type: 'init', role: 'p1', roomId }));
            if (r.p2 && r.p2.readyState === WebSocket.OPEN) {
              r.p1.send(JSON.stringify({ type: 'start' }));
              r.p2.send(JSON.stringify({ type: 'start' }));
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: '房间人数已满（最多2人），请更换房间号' }));
          }
        }
      } else if (curRoom && rooms.has(curRoom)) {
        // 消息对向转发 (P1 <-> P2)
        const r = rooms.get(curRoom)!;
        const target = curRole === 'p1' ? r.p2 : r.p1;
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(msgStr);
        }
      }
    } catch (e) {
      console.error('Error parsing WebSocket message:', e);
    }
  });

  const cleanup = () => {
    if (curRoom && rooms.has(curRoom)) {
      const r = rooms.get(curRoom)!;
      const target = curRole === 'p1' ? r.p2 : r.p1;
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'peer_leave' }));
      }

      if (curRole === 'p1') {
        r.p1 = null;
      } else if (curRole === 'p2') {
        r.p2 = null;
      }

      if (!r.p1 && !r.p2) {
        rooms.delete(curRoom);
      }
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.error('WebSocket client error:', err);
    cleanup();
  });
});

// 定期清理僵尸连接
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 25000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// API 接口
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    uptime: process.uptime(),
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, r]) => ({
    roomId: id,
    players: (r.p1 ? 1 : 0) + (r.p2 ? 1 : 0),
    isFull: !!(r.p1 && r.p2),
    createdAt: r.createdAt,
  }));
  res.json({ rooms: roomList });
});

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`雷电双人联机服务已启动在 http://0.0.0.0:${PORT}`);
  });
}

start();
