import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Volume2, VolumeX, Play, Users, RefreshCw, Wifi, Activity } from 'lucide-react';
import { Role, PlayerState, Bullet, Enemy, Particle, Star, WSMessage, GameMode } from '../types';
import { sounds } from '../utils/audio';

const V_W = 375;
const V_H = 667;

export default function RaidenGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 状态
  const [inGame, setInGame] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>('online');
  const [role, setRole] = useState<Role | null>(null);
  const [score, setScore] = useState(0);
  const [p1Hp, setP1Hp] = useState(3);
  const [p2Hp, setP2Hp] = useState(3);
  const [p1Alive, setP1Alive] = useState(true);
  const [p2Alive, setP2Alive] = useState(true);
  const [p1Kills, setP1Kills] = useState(0);
  const [p2Kills, setP2Kills] = useState(0);

  // 网络与房间
  const [serverHost, setServerHost] = useState(() => (typeof window !== 'undefined' ? window.location.host : 'localhost:3000'));
  const [roomId, setRoomId] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('room') || '';
    }
    return '';
  });
  const [statusMsg, setStatusMsg] = useState('输入房间号加入或创建对局');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [fps, setFps] = useState(60);
  const [ping, setPing] = useState<number | null>(null);

  // 引用变量存储游戏实时物理状态，避免频繁 re-render
  const wsRef = useRef<WebSocket | null>(null);
  const roleRef = useRef<Role | null>(null);
  const gameRunningRef = useRef(false);
  const scoreRef = useRef(0);
  const p1KillsRef = useRef(0);
  const p2KillsRef = useRef(0);
  const keysRef = useRef<{ [key: string]: boolean }>({});
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const httpFallbackActiveRef = useRef(false);
  const pendingHttpOutgoingRef = useRef<WSMessage[]>([]);
  const httpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const p1Ref = useRef<PlayerState>({ x: 120, y: 550, hp: 3, alive: true, color: '#00e5ff', stroke: '#80deea' });
  const p2Ref = useRef<PlayerState>({ x: 255, y: 550, hp: 3, alive: true, color: '#ff9100', stroke: '#ffe082' });

  // 工业级状态切片插值 (Time-sliced Snapshot Interpolation) 环形缓冲区结构
  interface StateSnapshot {
    x: number;
    y: number;
    vx: number;
    vy: number;
    t: number; // 本地接收时刻 performance.now()
  }
  interface PeerBufferState {
    snapshots: StateSnapshot[];
    initialized: boolean;
    lastPacketTime: number;
  }
  const p1BufferRef = useRef<PeerBufferState>({
    snapshots: [],
    initialized: false,
    lastPacketTime: 0,
  });
  const p2BufferRef = useRef<PeerBufferState>({
    snapshots: [],
    initialized: false,
    lastPacketTime: 0,
  });

  // 网络数据包 30Hz 节流发送 (约 33ms 一次，减少网络拥塞)
  const lastPosSendTimeRef = useRef(0);
  const lastSentPosRef = useRef({ x: 0, y: 0 });
  const pendingPosSendRef = useRef(false);

  const bulletsRef = useRef<Bullet[]>([]);
  const enemiesRef = useRef<Enemy[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const starsRef = useRef<Star[]>([]);
  interface FloatingText {
    x: number;
    y: number;
    text: string;
    color: string;
    alpha: number;
    vy: number;
  }
  const floatingTextsRef = useRef<FloatingText[]>([]);
  const syncTimerRef = useRef(0);

  const bulletTimerRef = useRef(0);
  const enemyTimerRef = useRef(0);
  const lastTimeRef = useRef(0);
  const animIdRef = useRef<number | null>(null);

  // 触控偏移
  const touchActiveRef = useRef(false);
  const touchOffsetRef = useRef({ x: 0, y: 0 });

  // 声音静音同步
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    sounds.setMuted(next);
  };

  const addFloatingText = useCallback((x: number, y: number, text: string, color: string) => {
    floatingTextsRef.current.push({
      x,
      y,
      text,
      color,
      alpha: 1.0,
      vy: -1.2,
    });
  }, []);

  const sendMsg = useCallback((obj: WSMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    } else if (httpFallbackActiveRef.current) {
      pendingHttpOutgoingRef.current.push(obj);
    }
  }, []);

  // 方案3：智能节流发送本地战机位置与瞬时速度
  const broadcastMyPosition = useCallback(
    (force = false) => {
      const currentRole = roleRef.current;
      if (!currentRole) return;
      const me = currentRole === 'p2' ? p2Ref.current : p1Ref.current;
      if (!me.alive) return;

      const now = performance.now();
      const elapsed = now - lastPosSendTimeRef.current;
      const dx = me.x - lastSentPosRef.current.x;
      const dy = me.y - lastSentPosRef.current.y;
      const moved = Math.hypot(dx, dy) > 0.4;

      if (force || (moved && elapsed >= 33)) {
        const dtSec = Math.max(0.016, elapsed / 1000);
        const vx = Math.round((dx / dtSec) * 10) / 10;
        const vy = Math.round((dy / dtSec) * 10) / 10;

        sendMsg({
          type: 'pos',
          role: currentRole,
          x: Math.round(me.x * 10) / 10,
          y: Math.round(me.y * 10) / 10,
          vx: force ? 0 : vx,
          vy: force ? 0 : vy,
          t: Math.round(now),
        });

        lastPosSendTimeRef.current = now;
        lastSentPosRef.current = { x: me.x, y: me.y };
        pendingPosSendRef.current = false;
      } else if (moved) {
        pendingPosSendRef.current = true;
      }
    },
    [sendMsg]
  );

  // 背景星空初始化
  const initStars = useCallback(() => {
    const list: Star[] = [];
    for (let i = 0; i < 60; i++) {
      list.push({
        x: Math.random() * V_W,
        y: Math.random() * V_H,
        r: Math.random() * 1.5 + 0.4,
        speed: Math.random() * 1.5 + 0.6,
        alpha: Math.random() * 0.6 + 0.25,
      });
    }
    starsRef.current = list;
  }, []);

  const createExplosion = useCallback((x: number, y: number, color: string) => {
    sounds.playExplosion();
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 4.5 + 2;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: Math.random() * 2.5 + 1.2,
        color,
        life: 1.0,
        decay: Math.random() * 0.03 + 0.03,
      });
    }
  }, []);

  const createEnemy = useCallback(() => {
    const size = 18 + Math.random() * 10;
    const id = 'e_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    enemiesRef.current.push({
      id,
      x: Math.random() * (V_W - size * 2) + size,
      y: -size - 10,
      vy: Math.random() * 1.8 + 1.8,
      w: size,
      h: size * 1.25,
      color: '#ff5252',
    });
  }, []);

  const createBullet = useCallback((player: PlayerState, isP1: boolean) => {
    if (!player.alive) return;
    sounds.playLaser(isP1);
    bulletsRef.current.push({
      x: player.x,
      y: player.y - 20,
      vy: -10,
      w: 3.5,
      h: 14,
      color: isP1 ? '#00e5ff' : '#ffea00',
    });
  }, []);

  const rectOverlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) => {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  };

  const checkGameOverCondition = useCallback(() => {
    const p1 = p1Ref.current;
    const p2 = p2Ref.current;
    if (!p1.alive && !p2.alive) {
      gameRunningRef.current = false;
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      setGameOver(true);
      sounds.playGameOver();
    }
  }, []);

  // 游戏主渲染与物理更新循环
  const updateAndRender = useCallback(
    (time: number) => {
      if (!gameRunningRef.current) return;
      const dt = Math.min(time - lastTimeRef.current, 50);
      lastTimeRef.current = time;

      if (dt > 0) {
        setFps(Math.round(1000 / dt));
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const p1 = p1Ref.current;
      const p2 = p2Ref.current;
      const currentRole = roleRef.current;
      const me = currentRole === 'p2' ? p2 : p1;

      // 键盘控制（支持桌面玩家通过 WASD / 方向键丝滑操作）
      if (me.alive) {
        const speed = 5.2;
        let dx = 0;
        let dy = 0;
        if (keysRef.current['ArrowLeft'] || keysRef.current['KeyA']) dx -= speed;
        if (keysRef.current['ArrowRight'] || keysRef.current['KeyD']) dx += speed;
        if (keysRef.current['ArrowUp'] || keysRef.current['KeyW']) dy -= speed;
        if (keysRef.current['ArrowDown'] || keysRef.current['KeyS']) dy += speed;

        if (dx !== 0 || dy !== 0) {
          me.x = Math.max(16, Math.min(V_W - 16, me.x + dx));
          me.y = Math.max(20, Math.min(V_H - 20, me.y + dy));
          broadcastMyPosition(false);
        }
      }

      // 方案3：处理待发送的 30Hz 限流位置数据包
      if (pendingPosSendRef.current && performance.now() - lastPosSendTimeRef.current >= 33) {
        broadcastMyPosition(false);
      }

      // 方案1升级：工业级时间切片插值引擎 (Time-sliced Snapshot Interpolation with 60ms Buffer)
      // 类似 CS/PUBG/球球大作战核心网络模型，彻底吸收 TCP 抖动，视觉极其丝滑
      const peerRole: Role = currentRole === 'p2' ? 'p1' : 'p2';
      const peer = peerRole === 'p1' ? p1 : p2;
      const peerBuffer = peerRole === 'p1' ? p1BufferRef.current : p2BufferRef.current;

      if (gameMode === 'online' && peerBuffer.initialized && peer.alive) {
        const snaps = peerBuffer.snapshots;
        const now = performance.now();
        // 60ms 插值缓冲窗口 (约 3~4 帧，完美平抑任何网络抖动与 TCP 延迟波动)
        const INTERPOLATION_DELAY = 60;
        const renderTime = now - INTERPOLATION_DELAY;

        if (snaps.length === 1) {
          peer.x = snaps[0].x;
          peer.y = snaps[0].y;
        } else if (snaps.length > 1) {
          const oldest = snaps[0];
          const latest = snaps[snaps.length - 1];

          if (renderTime <= oldest.t) {
            peer.x = oldest.x;
            peer.y = oldest.y;
          } else if (renderTime >= latest.t) {
            // 弱网或网络包迟到：启动 Dead Reckoning (航位推测) 平滑外推，限制在 120ms 内
            const extraTime = Math.min(0.12, (renderTime - latest.t) / 1000);
            const targetX = Math.max(16, Math.min(V_W - 16, latest.x + latest.vx * extraTime));
            const targetY = Math.max(20, Math.min(V_H - 20, latest.y + latest.vy * extraTime));
            const extrapolateFactor = 1 - Math.exp(-24 * (dt / 1000));
            peer.x += (targetX - peer.x) * extrapolateFactor;
            peer.y += (targetY - peer.y) * extrapolateFactor;
          } else {
            // 黄金插值区间：找到恰好覆盖 renderTime 的前后两个时间切片 S0 和 S1
            let s0 = oldest;
            let s1 = latest;
            for (let i = 0; i < snaps.length - 1; i++) {
              if (snaps[i].t <= renderTime && snaps[i + 1].t >= renderTime) {
                s0 = snaps[i];
                s1 = snaps[i + 1];
                break;
              }
            }

            const duration = s1.t - s0.t;
            if (duration > 0) {
              const ratio = Math.max(0, Math.min(1, (renderTime - s0.t) / duration));
              // 三次 Smoothstep 消除折角与生硬转折: 3*r^2 - 2*r^3
              const smoothRatio = ratio * ratio * (3 - 2 * ratio);
              const targetX = s0.x + (s1.x - s0.x) * smoothRatio;
              const targetY = s0.y + (s1.y - s0.y) * smoothRatio;

              if (Math.hypot(targetX - peer.x, targetY - peer.y) > 160) {
                peer.x = targetX;
                peer.y = targetY;
              } else {
                peer.x = targetX;
                peer.y = targetY;
              }
            } else {
              peer.x = s1.x;
              peer.y = s1.y;
            }
          }
        }
      }

      // 背景星星位移
      starsRef.current.forEach((s) => {
        s.y += s.speed;
        if (s.y > V_H) s.y = -5;
      });

      // 子弹定时发射 (各自只要存活均发射对应颜色激光)
      bulletTimerRef.current += dt;
      if (bulletTimerRef.current > 150) {
        bulletTimerRef.current = 0;
        if (p1.alive) createBullet(p1, true);
        if (p2.alive && (gameMode === 'online' || currentRole === 'p2')) {
          createBullet(p2, false);
        }
      }

      // 子弹飞行
      const bullets = bulletsRef.current;
      for (let i = bullets.length - 1; i >= 0; i--) {
        bullets[i].y += bullets[i].vy;
        if (bullets[i].y < -20) bullets.splice(i, 1);
      }

      // 1) 敌机仅由 P1 或单机演习模式负责生成
      if (currentRole === 'p1' || gameMode === 'practice') {
        enemyTimerRef.current += dt;
        const spawnRate = Math.max(450, 850 - scoreRef.current * 0.3);
        if (enemyTimerRef.current > spawnRate) {
          enemyTimerRef.current = 0;
          createEnemy();
        }

        // P1 定期向 P2 广播存活敌机（每 100ms 一次，减少网络拥塞并保持一致）
        syncTimerRef.current += dt;
        if (syncTimerRef.current > 100 && currentRole === 'p1' && gameMode === 'online') {
          syncTimerRef.current = 0;
          sendMsg({
            type: 'sync_enemies',
            list: enemiesRef.current.map((e) => ({
              id: e.id,
              x: Math.round(e.x),
              y: Math.round(e.y),
              vy: e.vy,
              w: Math.round(e.w),
              h: Math.round(e.h),
              color: e.color,
            })),
          });
        }
      }

      // 2) 无论 P1 还是 P2，每一帧都平滑更新敌机移动
      const enemies = enemiesRef.current;
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        e.y += e.vy;
        if (e.y > V_H + 30) {
          enemies.splice(i, 1);
        }
      }

      // 3) 核心修复：无论当前是 P1 还是 P2，本地所有子弹都会对敌机进行精准碰撞检测！
      // P2 橙色战机射出的每一发子弹都能立即击爆敌机，零延迟、零穿模！
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        let enemyHit = false;
        for (let j = bullets.length - 1; j >= 0; j--) {
          const b = bullets[j];
          if (rectOverlap(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
            // 判定发射者
            const isP1Bullet = b.color === '#00e5ff';
            const killerRole: Role = isP1Bullet ? 'p1' : 'p2';

            createExplosion(e.x, e.y, '#ff5252');
            addFloatingText(e.x, e.y, '+100', isP1Bullet ? '#00e5ff' : '#ff9100');

            enemies.splice(i, 1);
            bullets.splice(j, 1);

            scoreRef.current += 100;
            setScore(scoreRef.current);
            if (killerRole === 'p1') {
              p1KillsRef.current += 1;
              setP1Kills(p1KillsRef.current);
            } else {
              p2KillsRef.current += 1;
              setP2Kills(p2KillsRef.current);
            }

            enemyHit = true;

            // 联机模式下立即将击毁事件发送给队友，瞬间同步战果
            if (gameMode === 'online') {
              sendMsg({
                type: 'kill_enemy',
                id: e.id,
                ex: e.x,
                ey: e.y,
                killer: killerRole,
                score: scoreRef.current,
              });
            }
            break;
          }
        }
        if (enemyHit) continue;
      }

      // 4) 战机受击检测：各自客户端检测自身战机与敌机的撞击（避免网络延迟带来的幽灵撞击）
      if (currentRole === 'p1' || gameMode === 'practice') {
        if (p1.alive) {
          for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            if (rectOverlap(p1.x - 12, p1.y - 15, 24, 30, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
              createExplosion(p1.x, p1.y, p1.color);
              enemies.splice(i, 1);
              p1.hp--;
              if (p1.hp <= 0) p1.alive = false;
              setP1Hp(p1.hp);
              setP1Alive(p1.alive);
              if (gameMode === 'online') {
                sendMsg({ type: 'player_hit', target: 'p1', hp: p1.hp, alive: p1.alive });
              }
              checkGameOverCondition();
              break;
            }
          }
        }
      }

      if (currentRole === 'p2') {
        if (p2.alive) {
          for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            if (rectOverlap(p2.x - 12, p2.y - 15, 24, 30, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h)) {
              createExplosion(p2.x, p2.y, p2.color);
              enemies.splice(i, 1);
              p2.hp--;
              if (p2.hp <= 0) p2.alive = false;
              setP2Hp(p2.hp);
              setP2Alive(p2.alive);
              sendMsg({ type: 'player_hit', target: 'p2', hp: p2.hp, alive: p2.alive });
              checkGameOverCondition();
              break;
            }
          }
        }
      }

      // 爆炸粒子计算
      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) particles.splice(i, 1);
      }

      // ----------------- Canvas 渲染 -----------------
      ctx.save();
      ctx.scale(2, 2);

      // 深邃太空背景
      ctx.fillStyle = '#03030c';
      ctx.fillRect(0, 0, V_W, V_H);

      // 星空
      starsRef.current.forEach((s) => {
        ctx.globalAlpha = s.alpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1.0;

      // 子弹
      bulletsRef.current.forEach((b) => {
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 6;
        ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
      });
      ctx.shadowBlur = 0;

      // 敌机
      enemiesRef.current.forEach((e) => {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.beginPath();
        ctx.moveTo(0, e.h / 2);
        ctx.lineTo(-e.w / 2, -e.h / 2);
        ctx.lineTo(0, -e.h / 4);
        ctx.lineTo(e.w / 2, -e.h / 2);
        ctx.closePath();
        ctx.fillStyle = e.color;
        ctx.shadowColor = '#ff5252';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.strokeStyle = '#ff8a80';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      });

      // 爆炸粒子
      particlesRef.current.forEach((p) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // 绘制击毁得分浮字（+100）
      const fTexts = floatingTextsRef.current;
      for (let i = fTexts.length - 1; i >= 0; i--) {
        const ft = fTexts[i];
        ft.y += ft.vy;
        ft.alpha -= 0.025;
        if (ft.alpha <= 0) {
          fTexts.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = ft.alpha;
        ctx.fillStyle = ft.color;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.shadowColor = ft.color;
        ctx.shadowBlur = 6;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.restore();
      }

      // 绘制 P1 战机
      drawFighter(ctx, p1, true);
      // 绘制 P2 战机
      drawFighter(ctx, p2, false);

      ctx.restore();

      animIdRef.current = requestAnimationFrame(updateAndRender);
    },
    [createBullet, createEnemy, createExplosion, addFloatingText, gameMode, sendMsg, checkGameOverCondition, broadcastMyPosition]
  );

  // 战机机体绘制
  const drawFighter = (ctx: CanvasRenderingContext2D, p: PlayerState, isP1: boolean) => {
    if (!p.alive) return;
    ctx.save();
    ctx.translate(p.x, p.y);

    // 喷气引擎火焰动画
    const flicker = Math.random() * 5 + 6;
    ctx.beginPath();
    ctx.moveTo(-5, 8);
    ctx.lineTo(0, 8 + flicker);
    ctx.lineTo(5, 8);
    ctx.closePath();
    ctx.fillStyle = isP1 ? 'rgba(0, 229, 255, 0.85)' : 'rgba(255, 145, 0, 0.85)';
    ctx.shadowColor = isP1 ? '#00e5ff' : '#ff9100';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 机身主体
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(-14, 12);
    ctx.lineTo(0, 5);
    ctx.lineTo(14, 12);
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 驾驶舱高光
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // 战机头顶角色指示器
    ctx.fillStyle = isP1 ? '#00e5ff' : '#ff9100';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(isP1 ? 'P1' : 'P2', 0, -22);

    ctx.restore();
  };

  // 坐标映射：获取在 375x667 虚拟画布上的位置
  const getVirtualCoord = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * V_W;
    const y = ((clientY - rect.top) / rect.height) * V_H;
    return { x, y };
  };

  // 触控 & 鼠标平移
  const onPointerDown = (cx: number, cy: number) => {
    const me = roleRef.current === 'p2' ? p2Ref.current : p1Ref.current;
    if (!me.alive) return;
    touchActiveRef.current = true;
    const pos = getVirtualCoord(cx, cy);
    touchOffsetRef.current = {
      x: me.x - pos.x,
      y: me.y - pos.y,
    };
  };

  const onPointerMove = (cx: number, cy: number) => {
    if (!touchActiveRef.current || !gameRunningRef.current) return;
    const currentRole = roleRef.current;
    const me = currentRole === 'p2' ? p2Ref.current : p1Ref.current;
    if (!me.alive) return;
    const pos = getVirtualCoord(cx, cy);
    me.x = Math.max(16, Math.min(V_W - 16, pos.x + touchOffsetRef.current.x));
    me.y = Math.max(20, Math.min(V_H - 20, pos.y + touchOffsetRef.current.y));

    // 方案3：智能 30Hz 限流广播，防止高刷屏/高频 Touch 疯狂发包导致网络信道拥堵
    broadcastMyPosition(false);
  };

  const onPointerUp = () => {
    touchActiveRef.current = false;
    // 手指松开时强制发送一次静止坐标与零速度，确保对方精准停位
    broadcastMyPosition(true);
  };

  // 启动对局
  const startBattle = useCallback(() => {
    scoreRef.current = 0;
    setScore(0);
    p1KillsRef.current = 0;
    p2KillsRef.current = 0;
    setP1Kills(0);
    setP2Kills(0);
    floatingTextsRef.current = [];
    syncTimerRef.current = 0;

    p1Ref.current = { x: 120, y: 550, hp: 3, alive: true, color: '#00e5ff', stroke: '#80deea' };
    p2Ref.current = { x: 255, y: 550, hp: 3, alive: true, color: '#ff9100', stroke: '#ffe082' };

    // 重置双人插值与发包状态
    const initNow = performance.now();
    p1BufferRef.current = {
      snapshots: [{ x: 120, y: 550, vx: 0, vy: 0, t: initNow }],
      initialized: false,
      lastPacketTime: 0,
    };
    p2BufferRef.current = {
      snapshots: [{ x: 255, y: 550, vx: 0, vy: 0, t: initNow }],
      initialized: false,
      lastPacketTime: 0,
    };
    lastPosSendTimeRef.current = 0;
    const curRole = roleRef.current;
    lastSentPosRef.current = { x: curRole === 'p2' ? 255 : 120, y: 550 };
    pendingPosSendRef.current = false;

    setP1Hp(3);
    setP2Hp(3);
    setP1Alive(true);
    setP2Alive(true);

    bulletsRef.current = [];
    enemiesRef.current = [];
    particlesRef.current = [];
    bulletTimerRef.current = 0;
    enemyTimerRef.current = 0;

    initStars();
    sounds.playStart();

    setInGame(true);
    setGameOver(false);
    gameRunningRef.current = true;
    lastTimeRef.current = performance.now();
    animIdRef.current = requestAnimationFrame(updateAndRender);
  }, [initStars, updateAndRender]);

  // 单人训练模式
  const startSoloPractice = () => {
    if (httpTimerRef.current) {
      clearInterval(httpTimerRef.current);
      httpTimerRef.current = null;
    }
    httpFallbackActiveRef.current = false;
    setGameMode('practice');
    setRole('p1');
    roleRef.current = 'p1';
    startBattle();
  };

  // 统一消息调度处理（WebSocket 与 HTTP Fallback 共享同一套逻辑）
  const handleIncomingMessage = useCallback((data: WSMessage) => {
    try {
      if (data.type === 'init') {
        setRole(data.role);
        roleRef.current = data.role;
        setGameMode('online');
        if (data.roomId) {
          setRoomId(data.roomId);
        }
        if (data.role === 'p1') {
          setStatusMsg(`房间 ${data.roomId} 创建成功！你是【P1 房主(蓝)】，等待战友加入...`);
        } else {
          setStatusMsg(`成功加入房间 ${data.roomId}！你是【P2 僚机(橙)】`);
        }
      } else if (data.type === 'start') {
        setStatusMsg('双人就绪！战机引擎启动...');
        setIsConnecting(false);
        setTimeout(startBattle, 800);
      } else if (data.type === 'pos') {
        // 工业级状态切片插值 (Time-sliced Snapshot Interpolation) 接收端
        const isP1 = data.role === 'p1';
        const peerBuffer = isP1 ? p1BufferRef.current : p2BufferRef.current;
        const fighter = isP1 ? p1Ref.current : p2Ref.current;
        const now = performance.now();
        const newSnap: StateSnapshot = {
          x: data.x,
          y: data.y,
          vx: data.vx || 0,
          vy: data.vy || 0,
          t: now,
        };

        if (!peerBuffer.initialized) {
          fighter.x = data.x;
          fighter.y = data.y;
          peerBuffer.snapshots = [newSnap];
          peerBuffer.initialized = true;
          peerBuffer.lastPacketTime = now;
        } else {
          const lastSnap = peerBuffer.snapshots[peerBuffer.snapshots.length - 1];
          if (lastSnap && Math.hypot(data.x - lastSnap.x, data.y - lastSnap.y) > 160) {
            // 异常位移（如重生），清空快照瞬移对齐
            fighter.x = data.x;
            fighter.y = data.y;
            peerBuffer.snapshots = [newSnap];
          } else {
            peerBuffer.snapshots.push(newSnap);
            if (peerBuffer.snapshots.length > 12) {
              peerBuffer.snapshots.shift();
            }
          }
          peerBuffer.lastPacketTime = now;
        }
      } else if (data.type === 'pong') {
        if (typeof data.t === 'number') {
          const measured = Math.max(1, Math.round(performance.now() - data.t));
          setPing((prev) => (prev === null ? measured : Math.round(prev * 0.6 + measured * 0.4)));
        }
      } else if (data.type === 'sync_enemies') {
        // P2 平滑同步存活敌机列表
        if (roleRef.current === 'p2') {
          const currentMap = new Map<string, Enemy>(enemiesRef.current.map((e) => [e.id, e]));
          const nextList: Enemy[] = [];
          for (const item of data.list) {
            const existing = currentMap.get(item.id);
            if (existing) {
              existing.x = existing.x * 0.4 + item.x * 0.6;
              existing.y = Math.max(existing.y, item.y);
              existing.vy = item.vy;
              nextList.push(existing);
            } else {
              nextList.push({
                id: item.id,
                x: item.x,
                y: item.y,
                vy: item.vy,
                w: item.w,
                h: item.h,
                color: item.color,
              });
            }
          }
          enemiesRef.current = nextList;
        }
      } else if (data.type === 'kill_enemy' || data.type === 'hit_enemy') {
        createExplosion(data.ex, data.ey, '#ff5252');
        const killer = (data.type === 'kill_enemy' && data.killer) || 'p1';
        addFloatingText(data.ex, data.ey, '+100', killer === 'p1' ? '#00e5ff' : '#ff9100');
        scoreRef.current = data.score;
        setScore(data.score);

        if (killer === 'p1') {
          p1KillsRef.current += 1;
          setP1Kills(p1KillsRef.current);
        } else {
          p2KillsRef.current += 1;
          setP2Kills(p2KillsRef.current);
        }

        const targetId = data.id;
        const idx = enemiesRef.current.findIndex(
          (e) => (targetId && e.id === targetId) || Math.hypot(e.x - data.ex, e.y - data.ey) < 40
        );
        if (idx !== -1) {
          enemiesRef.current.splice(idx, 1);
        }
      } else if (data.type === 'player_hit') {
        const target = data.target === 'p1' ? p1Ref.current : p2Ref.current;
        target.hp = data.hp;
        target.alive = data.alive;
        createExplosion(target.x, target.y, target.color);
        if (data.target === 'p1') {
          setP1Hp(data.hp);
          setP1Alive(data.alive);
        } else {
          setP2Hp(data.hp);
          setP2Alive(data.alive);
        }
        checkGameOverCondition();
      } else if (data.type === 'peer_leave') {
        setStatusMsg('队友已退出房间');
        setInGame(false);
        gameRunningRef.current = false;
        if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      } else if (data.type === 'error') {
        setStatusMsg(`提示: ${data.message}`);
        setIsConnecting(false);
      }
    } catch (e) {
      console.error('Message handling error:', e);
    }
  }, [createExplosion, addFloatingText, checkGameOverCondition, startBattle]);

  // HTTP 高速备选通道（在手机浏览器或移动网络拦截 WebSocket 握手时自动无缝兜底）
  const startHttpSyncFallback = useCallback(async (rId: string) => {
    httpFallbackActiveRef.current = true;
    setStatusMsg(`已切换至 HTTP 安全通道连接 (房间 ${rId})...`);

    try {
      const joinRes = await fetch('/api/room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: rId }),
      });
      const joinData = await joinRes.json();
      if (joinData.role) {
        handleIncomingMessage({ type: 'init', role: joinData.role, roomId: rId });
        if (joinData.gameReady) {
          handleIncomingMessage({ type: 'start' });
        }
      }

      if (httpTimerRef.current) clearInterval(httpTimerRef.current);
      // 每 50ms 轮询批量上行并同步下行
      httpTimerRef.current = setInterval(async () => {
        if (!httpFallbackActiveRef.current) return;
        const outMessages = [...pendingHttpOutgoingRef.current];
        pendingHttpOutgoingRef.current.length = 0;

        const startTime = performance.now();
        try {
          const syncRes = await fetch('/api/room/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId: rId,
              role: roleRef.current || 'p1',
              messages: outMessages,
            }),
          });
          const latency = Math.max(1, Math.round(performance.now() - startTime));
          setPing((prev) => (prev === null ? latency : Math.round(prev * 0.7 + latency * 0.3)));

          if (syncRes.ok) {
            const syncData = await syncRes.json();
            if (Array.isArray(syncData.messages)) {
              syncData.messages.forEach((msgStr: string) => {
                try {
                  const m = JSON.parse(msgStr);
                  handleIncomingMessage(m);
                } catch {}
              });
            }
          }
        } catch (err) {
          console.warn('HTTP sync error:', err);
        }
      }, 50);
    } catch (err) {
      console.error('HTTP fallback failed:', err);
      setStatusMsg('网络连接异常，请检查网络后重试');
      setIsConnecting(false);
    }
  }, [handleIncomingMessage]);

  // 连接服务器（优先 WebSocket，受阻时自动无缝降级为 HTTP 备选通道）
  const connectServer = async () => {
    let cleanHost = serverHost.trim() || (typeof window !== 'undefined' ? window.location.host : 'localhost:3000');
    cleanHost = cleanHost.replace(/^(https?:\/\/|wss?:\/\/)/, '').replace(/\/+$/, '');
    const rId = roomId.trim() || '888';

    setStatusMsg('正在验证服务器连接...');
    setIsConnecting(true);

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (httpTimerRef.current) {
      clearInterval(httpTimerRef.current);
      httpTimerRef.current = null;
    }
    httpFallbackActiveRef.current = false;
    pendingHttpOutgoingRef.current = [];
    setPing(null);

    // 关键点：前置 fetch 激活同源鉴权 Cookie，规避云端 Nginx 302 拦截
    try {
      await fetch('/api/health', { credentials: 'include' });
    } catch (e) {
      console.warn('Preflight health check note:', e);
    }

    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${cleanHost}/ws`;

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      // 若 2 秒内未握手成功，自动降级为 HTTP 备用同步
      const wsTimeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN && !gameRunningRef.current) {
          console.warn('WebSocket handshake timeout, falling back to HTTP...');
          try {
            socket.close();
          } catch {}
          startHttpSyncFallback(rId);
        }
      }, 2000);

      socket.onopen = () => {
        clearTimeout(wsTimeout);
        setStatusMsg('已建立连接，正在进入房间 ' + rId + '...');
        socket.send(JSON.stringify({ type: 'join', roomId: rId }));
        socket.send(JSON.stringify({ type: 'ping', t: performance.now() }));
        pingIntervalRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping', t: performance.now() }));
          }
        }, 1500);
      };

      socket.onmessage = (event) => {
        try {
          const data: WSMessage = JSON.parse(event.data);
          handleIncomingMessage(data);
        } catch (e) {
          console.error(e);
        }
      };

      socket.onerror = () => {
        clearTimeout(wsTimeout);
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        // 如果握手受限，立即切换为 HTTP 备选通道，杜绝直接报错中断
        if (!gameRunningRef.current) {
          console.warn('WebSocket handshake failed, switching to HTTP sync...');
          startHttpSyncFallback(rId);
        }
      };

      socket.onclose = () => {
        clearTimeout(wsTimeout);
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        if (!httpFallbackActiveRef.current) {
          setPing(null);
          setIsConnecting(false);
          if (gameRunningRef.current) {
            setStatusMsg('连接已断开，请重连');
            gameRunningRef.current = false;
            setInGame(false);
          }
        }
      };
    } catch {
      startHttpSyncFallback(rId);
    }
  };

  // 键盘监听
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.code] = false;
      const anyMoveKeyPressed =
        keysRef.current['ArrowLeft'] ||
        keysRef.current['KeyA'] ||
        keysRef.current['ArrowRight'] ||
        keysRef.current['KeyD'] ||
        keysRef.current['ArrowUp'] ||
        keysRef.current['KeyW'] ||
        keysRef.current['ArrowDown'] ||
        keysRef.current['KeyS'];
      if (!anyMoveKeyPressed) {
        broadcastMyPosition(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [broadcastMyPosition]);

  // 画布尺寸 Retina 设定
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = V_W * 2;
      canvas.height = V_H * 2;
    }
    initStars();
  }, [initStars]);

  // 组件卸载时断开连接
  useEffect(() => {
    return () => {
      gameRunningRef.current = false;
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (httpTimerRef.current) {
        clearInterval(httpTimerRef.current);
        httpTimerRef.current = null;
      }
      httpFallbackActiveRef.current = false;
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return (
    <div id="game-main-container" className="flex flex-col lg:flex-row items-center justify-center h-[100dvh] min-h-[100svh] max-h-[100dvh] bg-neutral-950 p-1.5 sm:p-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-white font-mono select-none overflow-hidden box-border">
      {/* 核心游戏视口（固定 9:16 黄金手机纵向比例，精准适配 100svh/100dvh 视口高度） */}
      <div className="relative flex flex-col items-center justify-center max-h-full h-full">
        {/* 顶部快捷控制与操作说明提示栏 (音效与操作提示) */}
        <div className="mb-2 flex items-center justify-between w-full max-w-[390px] px-2 text-xs text-zinc-400 shrink-0">
          <div className="flex items-center gap-2">
            <button
              id="soundToggleBtn"
              onClick={toggleMute}
              className="p-2 rounded-lg bg-zinc-900/80 border border-zinc-800 hover:text-white transition flex items-center gap-1 text-xs"
              title={isMuted ? '开启音效' : '静音'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
              <span>{isMuted ? '静音' : '音效开'}</span>
            </button>
          </div>

          {/* 右上角网络延迟 (Ping) 实时仪表盘 */}
          <div id="network-ping-badge" className="flex items-center text-xs">
            {gameMode === 'practice' ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-zinc-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                <span className="text-[11px] font-bold text-zinc-300">单机 0ms</span>
              </div>
            ) : (
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900/90 border transition-all ${
                  ping === null
                    ? 'border-zinc-800 text-zinc-500'
                    : ping < 60
                    ? 'border-emerald-500/40 text-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.15)]'
                    : ping < 120
                    ? 'border-amber-500/40 text-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.15)]'
                    : 'border-red-500/50 text-red-400 shadow-[0_0_8px_rgba(248,113,113,0.2)]'
                }`}
                title="网络往返延迟 (Ping)"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    ping === null
                      ? 'bg-zinc-600 animate-pulse'
                      : ping < 60
                      ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                      : ping < 120
                      ? 'bg-amber-400 shadow-[0_0_6px_#fbbf24]'
                      : 'bg-red-400 animate-ping'
                  }`}
                />
                <Wifi className="w-3.5 h-3.5" />
                <span className="text-[11px] font-bold tracking-tight">
                  {ping === null ? (isConnecting ? '连接中...' : '未连线') : `Ping ${ping}ms`}
                </span>
              </div>
            )}
          </div>
        </div>

        <div
          id="gameWrapper"
          className="relative w-full aspect-[9/16] max-w-[390px] max-h-[calc(100svh-54px)] sm:max-h-[82vh] bg-[#020205] rounded-2xl overflow-hidden shadow-[0_0_40px_rgba(0,229,255,0.2)] border border-cyan-900/60 flex-shrink"
        >
          {/* 画布 */}
          <canvas
            id="gameCanvas"
            ref={canvasRef}
            className="w-full h-full block touch-none cursor-crosshair"
            onPointerDown={(e) => onPointerDown(e.clientX, e.clientY)}
            onPointerMove={(e) => onPointerMove(e.clientX, e.clientY)}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />

          {/* 游戏内顶部 HUD */}
          <div id="ui" className="absolute top-0 left-0 w-full p-3 pointer-events-none flex justify-between items-start text-xs font-bold z-10">
            <div id="p1-hud" className="text-cyan-400 drop-shadow-[0_0_6px_#00e5ff]">
              <div>P1(蓝) {role === 'p1' ? '【你】' : ''}</div>
              <div className="text-[10px] text-cyan-300/80">击杀: {p1Kills}</div>
              <div className="text-sm tracking-widest">{p1Alive ? '❤'.repeat(Math.max(0, p1Hp)) : '💀 坠毁'}</div>
            </div>

            <div id="score" className="text-center">
              <div className="text-[10px] text-cyan-200/60 tracking-wider">SCORE</div>
              <div className="text-lg text-white font-extrabold tracking-wider drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]">{score}</div>
            </div>

            <div id="p2-hud" className="text-amber-400 text-right drop-shadow-[0_0_6px_#ff9100]">
              <div>P2(橙) {role === 'p2' ? '【你】' : ''}</div>
              <div className="text-[10px] text-amber-300/80">击杀: {p2Kills}</div>
              <div className="text-sm tracking-widest">{p2Alive ? '❤'.repeat(Math.max(0, p2Hp)) : '💀 坠毁'}</div>
            </div>
          </div>

          {/* 战机角色与当前模式悬浮小标 */}
          {inGame && (
            <div className="absolute bottom-2 left-3 right-3 flex justify-between items-center pointer-events-none text-[10px] text-zinc-500">
              <span className="bg-black/50 px-2 py-0.5 rounded border border-zinc-800">
                {gameMode === 'practice' ? '单人单机演习' : `房间 ${roomId || '888'} · 协同作战`}
              </span>
              <span className="bg-black/50 px-2 py-0.5 rounded border border-zinc-800 flex items-center gap-1.5">
                <span>FPS: {fps}</span>
                <span className="text-zinc-600">|</span>
                <span className={ping !== null && ping < 60 ? 'text-emerald-400 font-bold' : ping !== null && ping < 120 ? 'text-amber-400 font-bold' : 'text-zinc-400'}>
                  {gameMode === 'practice' ? '0ms' : ping !== null ? `${ping}ms` : '--'}
                </span>
              </span>
            </div>
          )}

          {/* 弹窗遮罩 (未开始或游戏结束) */}
          {(!inGame || gameOver) && (
            <div
              id="overlay"
              className="absolute inset-0 bg-[#04050f]/95 backdrop-blur-sm flex flex-col items-center justify-center p-4 sm:p-6 text-center z-20 overflow-y-auto"
            >
              <h1 id="overlayTitle" className="text-xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-200 to-amber-400 tracking-wider drop-shadow-[0_0_15px_rgba(0,229,255,0.5)] mb-3 sm:mb-6">
                {gameOver ? '战机全军覆没' : '联机光标战机'}
              </h1>

              {gameOver && (
                <div className="my-4 p-4 rounded-xl bg-red-950/30 border border-red-500/30 w-full max-w-[280px]">
                  <div className="text-xs text-red-300">最终全队战绩</div>
                  <div className="text-3xl font-extrabold text-white mt-1">{score}</div>
                  <div className="mt-2.5 pt-2.5 border-t border-red-900/60 flex justify-around text-xs">
                    <span className="text-cyan-400 font-bold">P1(蓝): {p1Kills} 击杀</span>
                    <span className="text-amber-400 font-bold">P2(橙): {p2Kills} 击杀</span>
                  </div>
                </div>
              )}

              {/* 房间配置表单 */}
              <div className="w-full max-w-[280px] space-y-3 mb-4 text-left">
                <div>
                  <div className="mb-1">
                    <label className="text-[11px] text-zinc-400">房间号</label>
                  </div>
                  <input
                    id="roomId"
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="输入房间号 如 888"
                    className="w-full px-3 py-2.5 bg-zinc-900/90 border border-cyan-500/30 rounded-lg text-sm text-cyan-300 placeholder:text-[#4a8b8b] placeholder:font-bold focus:outline-none focus:border-cyan-400 font-bold"
                  />
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="w-full max-w-[280px] space-y-2">
                <button
                  id="connectBtn"
                  onClick={connectServer}
                  disabled={isConnecting}
                  className="w-full py-2.5 px-4 rounded-full bg-gradient-to-r from-cyan-500 to-sky-600 hover:from-cyan-400 hover:to-sky-500 text-black font-extrabold text-sm tracking-wide shadow-[0_0_15px_rgba(0,229,255,0.4)] transition active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isConnecting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      连接中...
                    </>
                  ) : (
                    <>
                      <Users className="w-4 h-4" />
                      {gameOver ? '重新建立联机' : '创建 / 加入房间'}
                    </>
                  )}
                </button>

                {/* 单人直接试玩按钮 */}
                <button
                  onClick={startSoloPractice}
                  className="w-full py-2 px-4 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 transition flex items-center justify-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5 text-amber-400" />
                  单人单机立即开战
                </button>
              </div>

              {/* 状态消息 */}
              <div id="statusMsg" className="mt-4 text-xs min-h-[20px] text-amber-300 max-w-[280px] leading-snug">
                {statusMsg}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 桌面端侧边操作面板与游戏说明 */}
      <div className="hidden lg:flex flex-col ml-8 max-w-sm space-y-4">
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 backdrop-blur-md">
          <div className="flex items-center gap-2 text-cyan-400 font-bold mb-3">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            双人联机机制
          </div>
          <ul className="text-xs text-zinc-300 space-y-2.5 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-cyan-400 font-bold">P1 (主机/蓝):</span>
              <span>负责生成敌机序列、仲裁子弹命中与全屏伤害判定，并同步给队友。</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-400 font-bold">P2 (僚机/橙):</span>
              <span>实时接收敌机航线与分数变动，协同集火打击敌军，各自 3 格护盾。</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 font-bold">联机方法:</span>
              <span>两人输入相同房间号点击【创建/加入】即可秒连。也可点击【开新标签测双人】在本地分屏自测！</span>
            </li>
          </ul>
        </div>

        <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 backdrop-blur-md">
          <div className="text-zinc-200 font-bold text-xs mb-2">操作指南</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
            <div className="bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/80">
              <div className="text-cyan-400 font-bold mb-1">手机/平板触控</div>
              <div>手指按住屏幕任意位置平移拖拽，战机自动跟随与开火。</div>
            </div>
            <div className="bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/80">
              <div className="text-amber-400 font-bold mb-1">PC / 笔记本键盘</div>
              <div>支持 <kbd className="bg-zinc-800 px-1 rounded text-white">WASD</kbd> 或 <kbd className="bg-zinc-800 px-1 rounded text-white">↑↓←→</kbd> 移动。</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
