import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

interface Room {
  p1: WebSocket | null;
  p2: WebSocket | null;
  createdAt: number;
  p1LastSeen: number;
  p2LastSeen: number;
  messagesForP1: string[];
  messagesForP2: string[];
}

const PORT = 3000;
const app = express();
const server = http.createServer(app);

// WebSocket 房间管理器: roomId => Room
const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      p1: null,
      p2: null,
      createdAt: Date.now(),
      p1LastSeen: Date.now(),
      p2LastSeen: Date.now(),
      messagesForP1: [],
      messagesForP2: [],
    });
  }
  return rooms.get(roomId)!;
}

const wss = new WebSocketServer({ noServer: true });

// 显式挂载 Upgrade 事件，确保兼容 /、/ws 等任何路径且不受中间件冲突
server.on('upgrade', (request, socket, head) => {
  try {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (err) {
    console.error('WebSocket upgrade error:', err);
    socket.destroy();
  }
});

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
        const r = getOrCreateRoom(roomId);

        if (!r.p1 || r.p1.readyState !== WebSocket.OPEN) {
          // 作为 P1 房主
          curRole = 'p1';
          r.p1 = ws;
          r.p1LastSeen = Date.now();
          ws.send(JSON.stringify({ type: 'init', role: 'p1', roomId }));
          // 如果对方 P2 已经在线，通知双方开战
          if (r.p2 && r.p2.readyState === WebSocket.OPEN) {
            r.p1.send(JSON.stringify({ type: 'start' }));
            r.p2.send(JSON.stringify({ type: 'start' }));
          }
        } else if (!r.p2 || r.p2.readyState !== WebSocket.OPEN) {
          // 作为 P2 加入
          curRole = 'p2';
          r.p2 = ws;
          r.p2LastSeen = Date.now();
          ws.send(JSON.stringify({ type: 'init', role: 'p2', roomId }));
          // 通知双方游戏开始
          if (r.p1 && r.p1.readyState === WebSocket.OPEN) {
            r.p1.send(JSON.stringify({ type: 'start' }));
          }
          if (r.p2 && r.p2.readyState === WebSocket.OPEN) {
            r.p2.send(JSON.stringify({ type: 'start' }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '房间人数已满（最多2人），请更换房间号' }));
        }
      } else if (curRoom && rooms.has(curRoom)) {
        // 消息对向转发 (P1 <-> P2)
        const r = rooms.get(curRoom)!;
        if (curRole === 'p1') r.p1LastSeen = Date.now();
        if (curRole === 'p2') r.p2LastSeen = Date.now();

        const target = curRole === 'p1' ? r.p2 : r.p1;
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(msgStr);
        }
        // 同时存一份到备用 HTTP 队列（如果对方临时使用 HTTP 同步）
        if (curRole === 'p1') {
          r.messagesForP2.push(msgStr);
          if (r.messagesForP2.length > 20) r.messagesForP2.shift();
        } else {
          r.messagesForP1.push(msgStr);
          if (r.messagesForP1.length > 20) r.messagesForP1.shift();
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

      // 如果 60 秒内没有玩家活动才删除房间
      if (!r.p1 && !r.p2 && Date.now() - Math.max(r.p1LastSeen, r.p2LastSeen) > 60000) {
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

// HTTP 备选联机端点（在手机/受限网络 WebSocket 握手被拦截时自动无缝兜底）
app.post('/api/room/join', (req, res) => {
  const roomId = (req.body?.roomId || '888').trim();
  const r = getOrCreateRoom(roomId);
  const now = Date.now();

  let assignedRole: 'p1' | 'p2' = 'p1';
  if (r.p1 || now - r.p1LastSeen < 6000) {
    assignedRole = 'p2';
    r.p2LastSeen = now;
  } else {
    assignedRole = 'p1';
    r.p1LastSeen = now;
  }

  res.json({
    status: 'ok',
    role: assignedRole,
    roomId,
    gameReady: (r.p1 || now - r.p1LastSeen < 6000) && (r.p2 || now - r.p2LastSeen < 6000),
  });
});

app.post('/api/room/sync', (req, res) => {
  const { roomId, role, messages } = req.body || {};
  if (!roomId || !role) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const r = getOrCreateRoom(roomId);
  const now = Date.now();
  if (role === 'p1') r.p1LastSeen = now;
  if (role === 'p2') r.p2LastSeen = now;

  if (Array.isArray(messages) && messages.length > 0) {
    messages.forEach((msg) => {
      const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
      const targetWs = role === 'p1' ? r.p2 : r.p1;
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(msgStr);
      }
      const queue = role === 'p1' ? r.messagesForP2 : r.messagesForP1;
      queue.push(msgStr);
      if (queue.length > 20) queue.shift();
    });
  }

  const myQueue = role === 'p1' ? r.messagesForP1 : r.messagesForP2;
  const incoming = [...myQueue];
  myQueue.length = 0;

  res.json({
    status: 'ok',
    messages: incoming,
    partnerActive: now - (role === 'p1' ? r.p2LastSeen : r.p1LastSeen) < 5000,
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
