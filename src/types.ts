export type Role = 'p1' | 'p2';

export interface PlayerState {
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  color: string;
  stroke: string;
}

export interface Bullet {
  x: number;
  y: number;
  vy: number;
  w: number;
  h: number;
  color: string;
}

export interface Enemy {
  id: string;
  x: number;
  y: number;
  vy: number;
  w: number;
  h: number;
  color: string;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  life: number;
  decay: number;
}

export interface Star {
  x: number;
  y: number;
  r: number;
  speed: number;
  alpha: number;
}

export type WSMessage =
  | { type: 'join'; roomId: string }
  | { type: 'init'; role: Role; roomId: string }
  | { type: 'start' }
  | { type: 'pos'; role: Role; x: number; y: number; vx?: number; vy?: number; t?: number }
  | { type: 'sync_enemies'; list: Array<{ id: string; x: number; y: number; vy: number; w: number; h: number; color: string }> }
  | { type: 'kill_enemy'; id: string; ex: number; ey: number; killer: Role; score: number }
  | { type: 'hit_enemy'; enemyIndex?: number; id?: string; ex: number; ey: number; score: number }
  | { type: 'player_hit'; target: Role; hp: number; alive: boolean }
  | { type: 'peer_leave' }
  | { type: 'error'; message: string }
  | { type: 'ping'; t?: number }
  | { type: 'pong'; t?: number };

export type GameMode = 'online' | 'practice';
