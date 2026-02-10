/*
Typed-array map storage (W*H sized):
- terrain: 0 water, 1 plains, 2 mountain
- owner: 0 neutral, 1 player, 2..N factions
- building: 0 none, 1 city, 2 defense
- bLevel: level for current building
- combatProg: per-tile capture progress [0..1]
Main loop: fixed-timestep simulation (20Hz) + requestAnimationFrame rendering.
*/

const CONFIG = {
  TICK_HZ: 20,
  BASE_POP_CAP: 8000,
  POP_CAP_PER_LAND_TILE: 30,
  CITY_POP_CAP_BONUS_PER_LEVEL: 25000,
  START_POP_CURRENT: 6500,
  START_GOLD: 2000,
  GOLD_PER_WORKER_PER_SEC: 0.015,
  WIN_LAND_PCT: 0.72,
  DEFENSE_RADIUS: 4,
  DEFENSE_BONUS_PER_LEVEL: 0.12,
  ATTACK_POWER_MULT: 0.020,
  DEF_POWER_BASE_MULT: 55,
  CAPTURE_PROG_GAIN: 0.0012,
  CAPTURE_PROG_DECAY: 0.00035,
  BOT_BURST_SEC: 1.5,
  CITY_BASE_COST: 2500,
  CITY_UPGRADE_MULT: 1.7,
  DEF_BASE_COST: 1800,
  DEF_UPGRADE_MULT: 1.6,
};

const DIFFICULTY = {
  easy: { THINK_INTERVAL_SEC: 1.5, ECON_MULT: 0.9, TARGET_WORKER_PCT: 0.65, TARGET_ATTACK_RATIO: 0.16 },
  normal: { THINK_INTERVAL_SEC: 1.0, ECON_MULT: 1.0, TARGET_WORKER_PCT: 0.6, TARGET_ATTACK_RATIO: 0.2 },
  hard: { THINK_INTERVAL_SEC: 0.6, ECON_MULT: 1.1, TARGET_WORKER_PCT: 0.55, TARGET_ATTACK_RATIO: 0.24 },
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
let W = 384, H = 216, N = 0;
let terrain, owner, building, bLevel, combatProg;
let factions = [];
let bots = [];
let totalLandTiles = 1;
let running = false;
let paused = false;
let speed = 1;
let gameOver = false;
let elapsed = 0;
let accum = 0;
let prevTs = 0;
let simTick = 0;
let playerAttackTarget = -1;
let mouseDown = false;
let buildMode = 0;
let hoveredTile = -1;
let flashRegions = [];

const camera = { x: 0, y: 0, zoom: 3.0, drag: false, lx: 0, ly: 0 };

const ui = {
  startMenu: document.getElementById('startMenu'),
  endScreen: document.getElementById('endScreen'),
  hud: document.getElementById('hud'),
  mapSizeSelect: document.getElementById('mapSizeSelect'),
  botCount: document.getElementById('botCount'),
  botCountLabel: document.getElementById('botCountLabel'),
  difficultySelect: document.getElementById('difficultySelect'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  speedBtn: document.getElementById('speedBtn'),
  restartBtn: document.getElementById('restartBtn'),
  statusLabel: document.getElementById('statusLabel'),
  stats: document.getElementById('stats'),
  workerSlider: document.getElementById('workerSlider'),
  attackSlider: document.getElementById('attackSlider'),
  workersLabel: document.getElementById('workersLabel'),
  attackLabel: document.getElementById('attackLabel'),
  buildCityBtn: document.getElementById('buildCityBtn'),
  buildDefenseBtn: document.getElementById('buildDefenseBtn'),
  cancelBuildBtn: document.getElementById('cancelBuildBtn'),
  tooltip: document.getElementById('tooltip'),
  endTitle: document.getElementById('endTitle'),
  endStats: document.getElementById('endStats'),
  playAgainBtn: document.getElementById('playAgainBtn'),
};

function idx(x, y) { return y * W + x; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function isEdge(x, y) { return x === 0 || y === 0 || x === W - 1 || y === H - 1; }
function tileToXY(i) { return [i % W, (i / W) | 0]; }

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function randInt(a, b) { return (Math.random() * (b - a + 1) + a) | 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function worldToScreen(wx, wy) {
  return [wx * camera.zoom + camera.x, wy * camera.zoom + camera.y];
}

function screenToWorld(sx, sy) {
  return [(sx - camera.x) / camera.zoom, (sy - camera.y) / camera.zoom];
}

function screenToTile(sx, sy) {
  const [wx, wy] = screenToWorld(sx, sy);
  const tx = Math.floor(wx), ty = Math.floor(wy);
  if (!inBounds(tx, ty)) return -1;
  return idx(tx, ty);
}

function getFactionColor(id) {
  if (id === 0) return '#5f6d60';
  if (id === 1) return '#43d4ff';
  const hue = (id * 47) % 360;
  return `hsl(${hue} 70% 58%)`;
}

function createMap(w, h) {
  W = w; H = h; N = W * H;
  terrain = new Uint8Array(N);
  owner = new Uint16Array(N);
  building = new Uint8Array(N);
  bLevel = new Uint8Array(N);
  combatProg = new Float32Array(N);

  const field = new Float32Array(N);
  const centers = randInt(5, 9);
  for (let c = 0; c < centers; c++) {
    const cx = randInt(0, W - 1), cy = randInt(0, H - 1);
    const amp = 0.7 + Math.random() * 1.3;
    const sigma = Math.min(W, H) * (0.08 + Math.random() * 0.15);
    const inv = 1 / (2 * sigma * sigma);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const d2 = dist2(x, y, cx, cy);
        field[i] += amp * Math.exp(-d2 * inv);
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const nx = x / W - 0.5, ny = y / H - 0.5;
      const radial = Math.sqrt(nx * nx + ny * ny);
      field[i] -= radial * 1.25;
      field[i] += (Math.random() - 0.5) * 0.09;
    }
  }

  let sorted = Array.from(field);
  sorted.sort((a, b) => a - b);
  const landFrac = 0.26 + Math.random() * 0.14;
  const threshold = sorted[Math.floor((1 - landFrac) * (sorted.length - 1))];
  for (let i = 0; i < N; i++) terrain[i] = field[i] > threshold ? 1 : 0;

  for (let it = 0; it < 2; it++) {
    const next = terrain.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = idx(x, y);
        let landN = 0;
        landN += terrain[idx(x + 1, y)] !== 0;
        landN += terrain[idx(x - 1, y)] !== 0;
        landN += terrain[idx(x, y + 1)] !== 0;
        landN += terrain[idx(x, y - 1)] !== 0;
        if (terrain[i] === 1 && landN <= 1) next[i] = 0;
        if (terrain[i] === 0 && landN >= 3) next[i] = 1;
      }
    }
    terrain = next;
  }

  const mountainSeeds = Math.max(3, ((W * H) / 8000) | 0);
  for (let s = 0; s < mountainSeeds; s++) {
    let seed = randInt(0, N - 1);
    for (let t = 0; t < 60 && terrain[seed] === 0; t++) seed = randInt(0, N - 1);
    if (terrain[seed] === 0) continue;
    const [sx, sy] = tileToXY(seed);
    const rad = randInt(3, 8);
    for (let y = sy - rad; y <= sy + rad; y++) {
      for (let x = sx - rad; x <= sx + rad; x++) {
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === 0) continue;
        const d = Math.sqrt(dist2(x, y, sx, sy));
        if (d <= rad && Math.random() < 0.2 + 0.5 * (1 - d / rad)) terrain[i] = 2;
      }
    }
  }

  let land = 0, mtn = 0;
  for (let i = 0; i < N; i++) { if (terrain[i] !== 0) land++; if (terrain[i] === 2) mtn++; }
  if (land > 0 && mtn / land > 0.16) {
    for (let i = 0; i < N; i++) if (terrain[i] === 2 && Math.random() < 0.35) terrain[i] = 1;
  }
  totalLandTiles = Math.max(1, terrain.reduce((s, t) => s + (t !== 0), 0));
}

function makeFaction(id, isBot, diff) {
  return {
    id,
    isBot,
    diff,
    gold: CONFIG.START_GOLD,
    popCurrent: CONFIG.START_POP_CURRENT,
    popCap: CONFIG.BASE_POP_CAP,
    workerPct: isBot ? DIFFICULTY[diff].TARGET_WORKER_PCT : 0.6,
    attackRatio: isBot ? DIFFICULTY[diff].TARGET_ATTACK_RATIO : 0.2,
    tilesOwnedLand: 0,
    cityLevels: 0,
    lostRecent: 0,
    burstTarget: -1,
    burstTicks: 0,
    thinkAcc: 0,
    defeatedAtLeastOnce: false,
  };
}

function findSpawnSeeds(count) {
  const seeds = [];
  const minDist = Math.max(18, Math.floor(Math.min(W, H) / 9));
  const tries = 8000;
  for (let t = 0; t < tries && seeds.length < count; t++) {
    const x = randInt(8, W - 9), y = randInt(8, H - 9);
    const i = idx(x, y);
    if (terrain[i] === 0) continue;
    let ok = true;
    for (const s of seeds) {
      if (Math.sqrt(dist2(x, y, s.x, s.y)) < minDist) { ok = false; break; }
    }
    if (ok) seeds.push({ x, y });
  }
  return seeds;
}

function claimStartingBlob(factionId, sx, sy) {
  const target = 40;
  const q = [idx(sx, sy)];
  const seen = new Uint8Array(N);
  seen[q[0]] = 1;
  let claimed = 0;
  while (q.length && claimed < target) {
    const i = q.shift();
    if (terrain[i] !== 0) {
      owner[i] = factionId;
      claimed++;
    }
    const [x, y] = tileToXY(i);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const d of dirs) {
      const nx = x + d[0], ny = y + d[1];
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni]) continue;
      if (terrain[ni] === 0) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
}

function recalcFactionStats() {
  for (const f of factions) { if (!f) continue; f.tilesOwnedLand = 0; f.cityLevels = 0; }
  for (let i = 0; i < N; i++) {
    if (terrain[i] === 0) continue;
    const o = owner[i];
    if (!o) continue;
    factions[o].tilesOwnedLand++;
    if (building[i] === 1) factions[o].cityLevels += bLevel[i];
  }
  for (const f of factions.slice(1)) {
    f.popCap = CONFIG.BASE_POP_CAP + f.tilesOwnedLand * CONFIG.POP_CAP_PER_LAND_TILE + f.cityLevels * CONFIG.CITY_POP_CAP_BONUS_PER_LEVEL;
    f.popCurrent = clamp(f.popCurrent, 0, f.popCap);
  }
}

function spawnGame(botCount, diff) {
  factions = [null];
  bots = [];
  factions[1] = makeFaction(1, false, diff);
  for (let b = 0; b < botCount; b++) {
    const id = b + 2;
    factions[id] = makeFaction(id, true, diff);
    bots.push(factions[id]);
  }
  const seeds = findSpawnSeeds(botCount + 1);
  for (let i = 0; i < seeds.length; i++) claimStartingBlob(i + 1, seeds[i].x, seeds[i].y);
  recalcFactionStats();
}

function hasAdjacentOwner(tile, ownerId) {
  const [x, y] = tileToXY(tile);
  if (x > 0 && owner[idx(x - 1, y)] === ownerId) return true;
  if (x < W - 1 && owner[idx(x + 1, y)] === ownerId) return true;
  if (y > 0 && owner[idx(x, y - 1)] === ownerId) return true;
  if (y < H - 1 && owner[idx(x, y + 1)] === ownerId) return true;
  return false;
}

function popGrowthRate(ratio) {
  const d = ratio - 0.45;
  let rate = 0.06 - 0.22 * d * d;
  if (ratio < 0.2) rate += 0.012 * (ratio / 0.2);
  return clamp(rate, 0.003, 0.065);
}

function cityCostAt(level) {
  if (level <= 0) return CONFIG.CITY_BASE_COST;
  return Math.round(CONFIG.CITY_BASE_COST * Math.pow(CONFIG.CITY_UPGRADE_MULT, level));
}
function defenseCostAt(level) {
  if (level <= 0) return CONFIG.DEF_BASE_COST;
  return Math.round(CONFIG.DEF_BASE_COST * Math.pow(CONFIG.DEF_UPGRADE_MULT, level));
}

function localDefenseMultiplier(defenderId, tx, ty) {
  let sum = 0;
  const r = CONFIG.DEFENSE_RADIUS;
  for (let y = ty - r; y <= ty + r; y++) {
    for (let x = tx - r; x <= tx + r; x++) {
      if (!inBounds(x, y)) continue;
      if (dist2(x, y, tx, ty) > r * r) continue;
      const i = idx(x, y);
      if (owner[i] === defenderId && building[i] === 2) sum += bLevel[i];
    }
  }
  return 1 + CONFIG.DEFENSE_BONUS_PER_LEVEL * sum;
}

function calcCombatNet(attacker, defender, tile) {
  const [tx, ty] = tileToXY(tile);
  const attackerTroops = attacker.popCurrent * (1 - attacker.workerPct);
  const atkTroops = attackerTroops * attacker.attackRatio;
  const atkPower = atkTroops * CONFIG.ATTACK_POWER_MULT;
  const defenderTroops = defender.popCurrent * (1 - defender.workerPct);
  const density = defenderTroops / Math.max(1, defender.tilesOwnedLand);
  const terrainMult = terrain[tile] === 2 ? 1.35 : 1.0;
  const localDef = localDefenseMultiplier(defender.id, tx, ty);
  const defPower = density * CONFIG.DEF_POWER_BASE_MULT * terrainMult * localDef;
  return { net: atkPower - defPower, atkTroops, atkPower, defPower };
}

function applyAttack(attackerId, targetTile, dtSec) {
  if (targetTile < 0 || targetTile >= N || terrain[targetTile] === 0) return;
  const defenderId = owner[targetTile];
  if (defenderId === attackerId) return;
  if (!hasAdjacentOwner(targetTile, attackerId)) return;
  const attacker = factions[attackerId];
  const defender = factions[defenderId] || { id: 0, popCurrent: 0, workerPct: 0.5, tilesOwnedLand: 1 };
  const { net, atkTroops, atkPower, defPower } = calcCombatNet(attacker, defender, targetTile);

  if (net >= 0) combatProg[targetTile] += net * CONFIG.CAPTURE_PROG_GAIN;
  else combatProg[targetTile] += net * CONFIG.CAPTURE_PROG_DECAY;
  combatProg[targetTile] = clamp(combatProg[targetTile], 0, 1);

  attacker.popCurrent = Math.max(0, attacker.popCurrent - atkTroops * 0.006 * dtSec);
  const frac = atkPower / Math.max(1e-6, atkPower + defPower);
  if (defenderId !== 0) {
    defender.popCurrent = Math.max(0, defender.popCurrent - Math.max(0, frac) * defPower * 0.0008 * dtSec);
  }

  if (combatProg[targetTile] >= 1) {
    const oldOwner = owner[targetTile];
    owner[targetTile] = attackerId;
    combatProg[targetTile] = 0;
    factions[oldOwner] && (factions[oldOwner].lostRecent += 1);
    handleEnclosureAfterCapture(attackerId, oldOwner, targetTile);
    recalcFactionStats();
  }
}

function getRegion(startTile, defenderId, seen) {
  const q = [startTile];
  seen[startTile] = 1;
  const region = [];
  let touchesEdge = false;
  while (q.length) {
    const i = q.pop();
    region.push(i);
    const [x, y] = tileToXY(i);
    if (isEdge(x, y)) touchesEdge = true;
    const ns = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for (const [nx, ny] of ns) {
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || terrain[ni] === 0 || owner[ni] !== defenderId) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return { region, touchesEdge };
}

function flashAnnex(region) {
  flashRegions.push({ region, ttl: 20 });
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = 720;
    g.gain.value = 0.04;
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.11);
  } catch (_) {}
}

function handleEnclosureAfterCapture(capturerId, defenderId, capturedTile) {
  if (!defenderId || defenderId === capturerId) return;
  const [cx, cy] = tileToXY(capturedTile);
  const around = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
  const seen = new Uint8Array(N);
  for (const [x, y] of around) {
    if (!inBounds(x, y)) continue;
    const i = idx(x, y);
    if (terrain[i] === 0 || owner[i] !== defenderId || seen[i]) continue;
    const res = getRegion(i, defenderId, seen);
    if (!res.touchesEdge) {
      for (const ti of res.region) owner[ti] = capturerId;
      flashAnnex(res.region);
    }
  }
}

function tryBuildAt(factionId, tile, mode) {
  if (tile < 0 || terrain[tile] === 0 || owner[tile] !== factionId) return false;
  const f = factions[factionId];
  if (mode === 1) {
    if (building[tile] !== 0 && building[tile] !== 1) return false;
    const currentLv = building[tile] === 1 ? bLevel[tile] : 0;
    const cost = cityCostAt(currentLv);
    if (f.gold < cost) return false;
    f.gold -= cost;
    building[tile] = 1;
    bLevel[tile] = currentLv + 1;
    recalcFactionStats();
    return true;
  }
  if (mode === 2) {
    if (building[tile] !== 0 && building[tile] !== 2) return false;
    const currentLv = building[tile] === 2 ? bLevel[tile] : 0;
    const cost = defenseCostAt(currentLv);
    if (f.gold < cost) return false;
    f.gold -= cost;
    building[tile] = 2;
    bLevel[tile] = currentLv + 1;
    return true;
  }
  return false;
}

function neutralExpand(f, dtSec) {
  if (f.popCurrent < f.popCap * 0.1) return;
  let best = -1, bestScore = -1e9;
  for (let i = 0; i < N; i++) {
    if (terrain[i] === 0 || owner[i] !== 0) continue;
    if (!hasAdjacentOwner(i, f.id)) continue;
    let s = terrain[i] === 1 ? 2 : 0.7;
    const [x, y] = tileToXY(i);
    if (isEdge(x, y)) s -= 0.2;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best >= 0) {
    owner[best] = f.id;
    f.popCurrent = Math.max(0, f.popCurrent - 2.0 * dtSec);
    recalcFactionStats();
  }
}

function borderConflict(f) {
  for (let i = 0; i < N; i++) {
    if (terrain[i] === 0 || owner[i] !== f.id) continue;
    const [x, y] = tileToXY(i);
    const ns = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for (const [nx, ny] of ns) {
      if (!inBounds(nx, ny)) continue;
      const o = owner[idx(nx, ny)];
      if (o !== 0 && o !== f.id) return true;
    }
  }
  return false;
}

function botThink(f, dtSec) {
  const dcfg = DIFFICULTY[f.diff];
  f.workerPct += (dcfg.TARGET_WORKER_PCT - f.workerPct) * 0.2;
  f.attackRatio += (dcfg.TARGET_ATTACK_RATIO - f.attackRatio) * 0.2;

  if (f.popCurrent > f.popCap * 0.92) {
    let best = -1;
    for (let i = 0; i < N; i++) {
      if (owner[i] !== f.id || terrain[i] === 0) continue;
      if (!hasAdjacentOwner(i, 0) && !isBorderEnemy(i, f.id)) { best = i; break; }
    }
    if (best >= 0) tryBuildAt(f.id, best, 1);
  }

  const underPressure = f.lostRecent > 1 || borderConflict(f);
  if (underPressure && f.gold >= CONFIG.DEF_BASE_COST) {
    const border = pickBorderTile(f.id);
    if (border >= 0) tryBuildAt(f.id, border, 2);
  }

  neutralExpand(f, dtSec);
  if (f.popCurrent < f.popCap * 0.25 && !underPressure) { f.burstTarget = -1; return; }

  let best = -1, bestScore = -1e9;
  for (let i = 0; i < N; i++) {
    if (terrain[i] === 0 || owner[i] === f.id || owner[i] === 0) continue;
    if (!hasAdjacentOwner(i, f.id)) continue;
    const enemy = factions[owner[i]];
    const eTroops = enemy.popCurrent * (1 - enemy.workerPct);
    const weakness = 220 / (1 + eTroops / Math.max(1, enemy.tilesOwnedLand));
    const enclosure = estimateEnclosurePotential(i, owner[i]);
    const prox = hasAdjacentOwner(i, 1) ? 8 : 3;
    const terrainPenalty = terrain[i] === 2 ? 10 : 0;
    const [tx, ty] = tileToXY(i);
    const defensePenalty = (localDefenseMultiplier(owner[i], tx, ty) - 1) * 12;
    const score = weakness + enclosure + prox - terrainPenalty - defensePenalty;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  f.burstTarget = best;
  f.burstTicks = Math.floor(CONFIG.BOT_BURST_SEC * CONFIG.TICK_HZ);
  f.lostRecent = Math.max(0, f.lostRecent - 1);
}

function estimateEnclosurePotential(tile, enemyId) {
  const [x, y] = tileToXY(tile);
  let behind = 0;
  const ns = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
  for (const [nx, ny] of ns) {
    if (!inBounds(nx, ny)) continue;
    const ni = idx(nx, ny);
    if (owner[ni] === enemyId) {
      if (!isEdge(nx, ny)) behind += 2;
      if (!hasAdjacentOwner(ni, 0)) behind += 1;
    }
  }
  return behind;
}

function isBorderEnemy(tile, fId) {
  const [x, y] = tileToXY(tile);
  const ns = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
  for (const [nx, ny] of ns) {
    if (!inBounds(nx, ny)) continue;
    const o = owner[idx(nx, ny)];
    if (o !== 0 && o !== fId) return true;
  }
  return false;
}

function pickBorderTile(fId) {
  let candidate = -1;
  for (let i = 0; i < N; i++) {
    if (owner[i] !== fId || terrain[i] === 0) continue;
    if (isBorderEnemy(i, fId)) { candidate = i; break; }
  }
  return candidate;
}

function stepSimulation(dtSec) {
  simTick++;
  for (const f of factions.slice(1)) {
    const workers = f.popCurrent * f.workerPct;
    const econMult = f.isBot ? DIFFICULTY[f.diff].ECON_MULT : 1;
    f.gold += workers * CONFIG.GOLD_PER_WORKER_PER_SEC * econMult * dtSec;

    const ratio = f.popCurrent / Math.max(1, f.popCap);
    const gRate = popGrowthRate(ratio);
    f.popCurrent += f.popCurrent * gRate * dtSec;
    f.popCurrent = clamp(f.popCurrent, 0, f.popCap);
  }

  if (mouseDown && playerAttackTarget >= 0) {
    if (owner[playerAttackTarget] > 1 && hasAdjacentOwner(playerAttackTarget, 1)) applyAttack(1, playerAttackTarget, dtSec);
    else playerAttackTarget = -1;
  }

  for (const bot of bots) {
    bot.thinkAcc += dtSec;
    if (bot.thinkAcc >= DIFFICULTY[bot.diff].THINK_INTERVAL_SEC) {
      botThink(bot, dtSec);
      bot.thinkAcc = 0;
    }
    if (bot.burstTarget >= 0 && bot.burstTicks > 0) {
      applyAttack(bot.id, bot.burstTarget, dtSec);
      bot.burstTicks--;
      if (owner[bot.burstTarget] === bot.id || !hasAdjacentOwner(bot.burstTarget, bot.id)) bot.burstTicks = 0;
    }
  }

  if (simTick % CONFIG.TICK_HZ === 0) recalcFactionStats();
  for (const fr of flashRegions) fr.ttl--;
  flashRegions = flashRegions.filter(f => f.ttl > 0);

  checkEndConditions();
}

function checkEndConditions() {
  const p = factions[1];
  const pct = p.tilesOwnedLand / totalLandTiles;
  if (!gameOver && pct >= CONFIG.WIN_LAND_PCT) endGame(true);
  if (!gameOver && p.tilesOwnedLand <= 0) endGame(false);
}

function endGame(win) {
  gameOver = true;
  running = false;
  const p = factions[1];
  let largest = 0, defeated = 0;
  for (const b of bots) {
    largest = Math.max(largest, b.tilesOwnedLand);
    if (b.tilesOwnedLand === 0) defeated++;
  }
  ui.endTitle.textContent = win ? 'Victory!' : 'Defeat';
  ui.endStats.innerHTML = `
    <p>Time: ${elapsed.toFixed(1)}s</p>
    <p>Final Land: ${(100 * p.tilesOwnedLand / totalLandTiles).toFixed(1)}%</p>
    <p>Bots Defeated: ${defeated}</p>
    <p>Largest Enemy Land: ${largest}</p>
  `;
  ui.endScreen.classList.remove('hidden');
}

function renderMap() {
  ctx.fillStyle = '#103060';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tilePix = camera.zoom;
  const startX = clamp(Math.floor((-camera.x) / tilePix) - 1, 0, W - 1);
  const startY = clamp(Math.floor((-camera.y) / tilePix) - 1, 0, H - 1);
  const endX = clamp(Math.ceil((canvas.width - camera.x) / tilePix) + 1, 0, W - 1);
  const endY = clamp(Math.ceil((canvas.height - camera.y) / tilePix) + 1, 0, H - 1);

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const i = idx(x, y);
      const sx = x * tilePix + camera.x;
      const sy = y * tilePix + camera.y;
      if (terrain[i] === 0) {
        ctx.fillStyle = '#1a3f7a';
      } else {
        ctx.fillStyle = getFactionColor(owner[i]);
        if (terrain[i] === 2) ctx.fillStyle = shade(ctx.fillStyle, -18);
      }
      ctx.fillRect(sx, sy, tilePix + 0.4, tilePix + 0.4);

      if (combatProg[i] > 0 && owner[i] !== 1) {
        ctx.fillStyle = `rgba(255,255,255,${0.10 + combatProg[i] * 0.25})`;
        ctx.fillRect(sx, sy, tilePix, tilePix);
      }

      if (building[i] !== 0 && owner[i] !== 0) {
        ctx.fillStyle = building[i] === 1 ? '#ffd15f' : '#ff8f75';
        const r = Math.max(1, tilePix * 0.25 + bLevel[i] * 0.12);
        ctx.fillRect(sx + tilePix * 0.5 - r * 0.5, sy + tilePix * 0.5 - r * 0.5, r, r);
      }
    }
  }

  drawBorders(startX, startY, endX, endY, tilePix);
  drawAnnexFlash(tilePix);
}

function shade(c, amt) {
  if (!c.startsWith('#')) return c;
  let n = parseInt(c.slice(1), 16);
  let r = ((n >> 16) & 255) + amt;
  let g = ((n >> 8) & 255) + amt;
  let b = (n & 255) + amt;
  r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255);
  return `rgb(${r},${g},${b})`;
}

function drawBorders(sx, sy, ex, ey, tilePix) {
  ctx.strokeStyle = 'rgba(8,12,20,0.65)';
  ctx.lineWidth = Math.max(1, tilePix * 0.08);
  ctx.beginPath();
  for (let y = sy; y <= ey; y++) {
    for (let x = sx; x <= ex; x++) {
      const i = idx(x, y);
      if (terrain[i] === 0) continue;
      const o = owner[i];
      const px = x * tilePix + camera.x;
      const py = y * tilePix + camera.y;
      if (x < W - 1 && owner[idx(x + 1, y)] !== o) { ctx.moveTo(px + tilePix, py); ctx.lineTo(px + tilePix, py + tilePix); }
      if (y < H - 1 && owner[idx(x, y + 1)] !== o) { ctx.moveTo(px, py + tilePix); ctx.lineTo(px + tilePix, py + tilePix); }
    }
  }
  ctx.stroke();
}

function drawAnnexFlash(tilePix) {
  if (!flashRegions.length) return;
  ctx.strokeStyle = 'rgba(255,255,150,0.9)';
  ctx.lineWidth = Math.max(1, tilePix * 0.22);
  for (const fr of flashRegions) {
    const alpha = fr.ttl / 20;
    ctx.globalAlpha = alpha;
    for (const i of fr.region) {
      const [x, y] = tileToXY(i);
      const px = x * tilePix + camera.x;
      const py = y * tilePix + camera.y;
      ctx.strokeRect(px + 0.5, py + 0.5, tilePix - 1, tilePix - 1);
    }
  }
  ctx.globalAlpha = 1;
}

function updateHud() {
  if (!factions[1]) return;
  const p = factions[1];
  const workers = p.popCurrent * p.workerPct;
  const troops = p.popCurrent - workers;
  const landPct = 100 * p.tilesOwnedLand / totalLandTiles;
  ui.stats.innerHTML = `
    <div>Gold: ${p.gold.toFixed(0)}</div>
    <div>Land: ${landPct.toFixed(1)}%</div>
    <div>Pop: ${p.popCurrent.toFixed(0)}</div>
    <div>Pop Cap: ${p.popCap.toFixed(0)}</div>
    <div>Troops: ${troops.toFixed(0)}</div>
    <div>Workers: ${workers.toFixed(0)}</div>
  `;
  ui.statusLabel.textContent = paused ? 'Paused' : '';

  if (hoveredTile >= 0) {
    const t = terrain[hoveredTile] === 0 ? 'Water' : (terrain[hoveredTile] === 1 ? 'Plains' : 'Mountain');
    const o = owner[hoveredTile] === 0 ? 'Neutral' : (owner[hoveredTile] === 1 ? 'Player' : `Bot ${owner[hoveredTile]-1}`);
    const b = building[hoveredTile] === 0 ? 'None' : (building[hoveredTile] === 1 ? `City L${bLevel[hoveredTile]}` : `Defense L${bLevel[hoveredTile]}`);
    ui.tooltip.textContent = `Tile ${hoveredTile}: ${t} | Owner: ${o} | Building: ${b}`;
  }
}

function frame(ts) {
  if (!prevTs) prevTs = ts;
  const dt = Math.min(0.1, (ts - prevTs) / 1000);
  prevTs = ts;

  if (running && !paused && !gameOver) {
    elapsed += dt;
    accum += dt * speed;
    const fixed = 1 / CONFIG.TICK_HZ;
    while (accum >= fixed) {
      stepSimulation(fixed);
      accum -= fixed;
    }
  }

  renderMap();
  updateHud();
  requestAnimationFrame(frame);
}

function initUI() {
  ui.botCount.addEventListener('input', () => ui.botCountLabel.textContent = ui.botCount.value);
  ui.startBtn.addEventListener('click', startNewGame);
  ui.pauseBtn.addEventListener('click', () => { paused = !paused; ui.pauseBtn.textContent = paused ? 'Resume' : 'Pause'; });
  ui.speedBtn.addEventListener('click', () => { speed = speed === 1 ? 2 : 1; ui.speedBtn.textContent = `Speed: ${speed}x`; });
  ui.restartBtn.addEventListener('click', startNewGame);
  ui.playAgainBtn.addEventListener('click', () => {
    ui.endScreen.classList.add('hidden');
    ui.startMenu.classList.remove('hidden');
    ui.hud.classList.add('hidden');
    running = false;
  });

  ui.workerSlider.addEventListener('input', () => {
    const v = Number(ui.workerSlider.value) / 100;
    factions[1] && (factions[1].workerPct = v);
    ui.workersLabel.textContent = `${ui.workerSlider.value}%`;
  });
  ui.attackSlider.addEventListener('input', () => {
    const v = Number(ui.attackSlider.value) / 100;
    factions[1] && (factions[1].attackRatio = v);
    ui.attackLabel.textContent = `${ui.attackSlider.value}%`;
  });

  ui.buildCityBtn.addEventListener('click', () => buildMode = 1);
  ui.buildDefenseBtn.addEventListener('click', () => buildMode = 2);
  ui.cancelBuildBtn.addEventListener('click', () => buildMode = 0);
}

function startNewGame() {
  const [w, h] = ui.mapSizeSelect.value.split('x').map(Number);
  const botCount = Number(ui.botCount.value);
  const diff = ui.difficultySelect.value;

  createMap(w, h);
  spawnGame(botCount, diff);

  camera.zoom = Math.max(2, Math.min(window.innerWidth / W, window.innerHeight / H));
  camera.x = (window.innerWidth - W * camera.zoom) * 0.5;
  camera.y = (window.innerHeight - H * camera.zoom) * 0.5;

  playerAttackTarget = -1;
  buildMode = 0;
  elapsed = 0;
  accum = 0;
  gameOver = false;
  paused = false;
  running = true;

  ui.pauseBtn.textContent = 'Pause';
  ui.speedBtn.textContent = `Speed: ${speed}x`;
  ui.startMenu.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.endScreen.classList.add('hidden');
}

canvas.addEventListener('mousedown', (e) => {
  if (!running || gameOver) return;
  if (e.button === 1 || e.button === 2) {
    camera.drag = true;
    camera.lx = e.clientX;
    camera.ly = e.clientY;
    return;
  }
  mouseDown = true;
  const t = screenToTile(e.clientX, e.clientY);
  if (t < 0) return;

  if (buildMode !== 0) {
    tryBuildAt(1, t, buildMode);
    return;
  }
  if (terrain[t] !== 0 && owner[t] > 1 && hasAdjacentOwner(t, 1)) playerAttackTarget = t;
});

window.addEventListener('mouseup', () => { mouseDown = false; playerAttackTarget = -1; camera.drag = false; });
canvas.addEventListener('mousemove', (e) => {
  hoveredTile = screenToTile(e.clientX, e.clientY);
  if (camera.drag) {
    camera.x += e.clientX - camera.lx;
    camera.y += e.clientY - camera.ly;
    camera.lx = e.clientX;
    camera.ly = e.clientY;
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const oldZoom = camera.zoom;
  camera.zoom = clamp(camera.zoom * factor, 1.2, 12);
  const wx = (e.clientX - camera.x) / oldZoom;
  const wy = (e.clientY - camera.y) / oldZoom;
  camera.x = e.clientX - wx * camera.zoom;
  camera.y = e.clientY - wy * camera.zoom;
}, { passive: false });

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
initUI();
createMap(W, H);
requestAnimationFrame(frame);
