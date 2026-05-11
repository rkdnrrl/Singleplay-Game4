import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ── 게스트 전용 localStorage 키 ─────────────────────────── */
const LS = {
  PLACED:        'sg4_placed_v2',
  PLACED_LEGACY: 'sg4_placed_v1',
  INV:           'sg4_inv_v1',
  GUEST_WALLET:  'sg4_guest_wallet_v1',
  FLOOR_CELLS:   'sg4_floor_cells_v1',
  FLOOR_UNPLACED:'sg4_floor_unplaced_v1',
  VOXEL_LIB:    'sg4_voxel_lib_v1',
  VOXEL_PLACED:  'sg4_voxel_placed_v1',
};

/* ── 복셀 상수 ───────────────────────────────────────────── */
const VOXEL_GRID  = 32;
const VOXEL_SCALE = 0.045; // 월드 단위/복셀

const PALETTE_COLORS = [
  '#ffffff','#cccccc','#888888','#444444','#000000','#c62828',
  '#f4511e','#fb8c00','#f9a825','#7cb342','#2e7d32','#00897b',
  '#0277bd','#1565c0','#4527a0','#6a1b9a','#ad1457','#880e4f',
  '#ffd180','#b9f6ca','#80d8ff','#ea80fc','#ff6e40','#e0e0e0',
];

const GUEST_START_COINS = 1200;
/** 레거시 배치 좌표 변환용 (옛 저장 데이터) */
const ROOM_HALF = 3.6;
/** 바닥 한 칸 너비(월드 단위). 타일 중심은 (gx * TILE_WORLD, gz * TILE_WORLD) */
const TILE_WORLD = 2;

const CATALOG = [
  { id: 'floor_tile', name: '바닥 타일', price: 50, emoji: '⬜', isFloorTile: true },
  { id: 'sofa',  name: '소파',   price: 120, emoji: '🛋️',  w: 1.8,  d: 0.85, h: 0.7,  color: 0x6d4c41 },
  { id: 'plant', name: '화분',   price: 45,  emoji: '🪴',  w: 0.4,  d: 0.4,  h: 0.6,  color: 0x388e3c },
  { id: 'lamp',  name: '스탠드', price: 60,  emoji: '💡',  w: 0.28, d: 0.28, h: 1.45, color: 0xffb300 },
  { id: 'table', name: '테이블', price: 90,  emoji: '🪑',  w: 1.15, d: 0.75, h: 0.48, color: 0x5d4037 },
  { id: 'tv',    name: 'TV',     price: 200, emoji: '📺',  w: 1.25, d: 0.1,  h: 0.72, color: 0x263238 },
  { id: 'rug',   name: '러그',   price: 75,  emoji: '🟫',  w: 2.1,  d: 1.4,  h: 0.04, color: 0x795548 },
  { id: 'clock', name: '시계',   price: 55,  emoji: '🕐',  w: 0.45, d: 0.08, h: 0.55, color: 0x8d6e63 },
  { id: 'art',   name: '그림',   price: 85,  emoji: '🖼️', w: 0.85, d: 0.06, h: 1.05, color: 0x5c6bc0 },
];

const catalogById = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
const FURNITURE_CATALOG = CATALOG.filter((c) => !c.isFloorTile);

/* ── DOM ───────────────────────────────────────────────── */
const loginOverlay      = document.getElementById('loginOverlay');
const roomHost          = document.getElementById('roomHost');
const coinDisplay       = document.getElementById('coinDisplay');
const serverCoinDisplay = document.getElementById('serverCoinDisplay');
const coinHint          = document.getElementById('coinHint');
const shopList          = document.getElementById('shopList');
const invList           = document.getElementById('invList');
const placeHint         = document.getElementById('placeHint');
const btnRemoveSelected = document.getElementById('btnRemoveSelected');
const shopPanel         = document.getElementById('shopPanel');
const invPanel          = document.getElementById('invPanel');
const createPanel       = document.getElementById('createPanel');

/* ── 플랫폼 연동 ──────────────────────────────────────── */
const urlParams   = new URLSearchParams(window.location.search);
const alpToken    = urlParams.get('token');
const platformApi = window.__ALP_PLATFORM_API__ || '';

let isLoggedIn      = false;
let serverCoins     = 0;
let selectedPlaceId = null;   // DB id 또는 게스트 placeId
let selectedCatalogId = null;
/** 바닥 타일 칸 선택 (치우기용) */
let selectedFloorCell = null; // { gx, gz } | null
let lastDragEndTime = 0;

/* ── DB 가구 상태 (로그인 시) ───────────────────────────── */
// [{ id, catId, placed, posX, posZ, rotY, purchasedAt }]
let dbItems = [];
// [{ id, name, price, voxels, createdAt, updatedAt }]
let dbVoxelObjects = [];
// [{ id, voxelObjectId, posX, posZ, rotY, placedAt }]
let dbVoxelPlacements = [];

function getDbInventory() {
  const inv = {};
  dbItems.filter(i => !i.placed).forEach(i => {
    inv[i.catId] = (inv[i.catId] || 0) + 1;
  });
  return inv;
}

function getDbPlaced() {
  return dbItems.filter(i => i.placed).map(i => ({
    id: i.id, catId: i.catId,
    x: i.posX ?? 0, z: i.posZ ?? 0, ry: i.rotY ?? 0,
  }));
}

/* ── 게스트 localStorage 헬퍼 ──────────────────────────── */
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function saveJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function getGuestInventory() {
  const inv = loadJson(LS.INV, {});
  return typeof inv === 'object' && inv !== null ? inv : {};
}
function setGuestInventory(inv) { saveJson(LS.INV, inv); }

function migrateLegacyPlaced(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const first = arr[0];
  if (first && typeof first.z === 'number') return arr;
  if (first && typeof first.x === 'number') {
    const scale = ROOM_HALF * 1.8;
    const m = TILE_WORLD / 2 - 0.2;
    return arr.map((p) => ({
      id: p.id, catId: p.catId,
      x: Math.max(-m, Math.min(m, ((p.x / 100) - 0.5) * scale)),
      z: Math.max(-m, Math.min(m, ((0.5 - p.y / 100) * scale))),
      ry: typeof p.ry === 'number' ? p.ry : 0,
    }));
  }
  return [];
}
function getGuestPlaced() {
  let arr = loadJson(LS.PLACED, []);
  if (!Array.isArray(arr) || arr.length === 0) {
    const legacy = loadJson(LS.PLACED_LEGACY, []);
    arr = migrateLegacyPlaced(legacy);
    if (arr.length) saveJson(LS.PLACED, arr);
  }
  return Array.isArray(arr) ? arr : [];
}
function setGuestPlaced(arr) { saveJson(LS.PLACED, arr); }

function getFloorCells() {
  const raw = loadJson(LS.FLOOR_CELLS, null);
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter((c) => Number.isFinite(c.gx) && Number.isFinite(c.gz))
      .map((c) => ({ gx: c.gx | 0, gz: c.gz | 0 }));
  }
  return [{ gx: 0, gz: 0 }];
}

function setFloorCells(cells) {
  const seen = new Set();
  const uniq = [];
  for (const c of cells) {
    const gx = c.gx | 0;
    const gz = c.gz | 0;
    const k = `${gx},${gz}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ gx, gz });
  }
  saveJson(LS.FLOOR_CELLS, uniq);
}

function getFloorUnplaced() {
  const n = Number(localStorage.getItem(LS.FLOOR_UNPLACED));
  return Number.isFinite(n) && n > 0 ? n | 0 : 0;
}

function setFloorUnplaced(n) {
  localStorage.setItem(LS.FLOOR_UNPLACED, String(Math.max(0, n | 0)));
}

/* ── 복셀 라이브러리 / 배치 헬퍼 (localStorage — 게스트용) ── */
function loadVoxelLib()       { return loadJson(LS.VOXEL_LIB, []); }
function saveVoxelLib(lib)    { saveJson(LS.VOXEL_LIB, lib); }
function loadVoxelPlaced()    { return loadJson(LS.VOXEL_PLACED, []); }
function saveVoxelPlaced(arr) { saveJson(LS.VOXEL_PLACED, arr); }

/** 로그인 여부에 따라 올바른 복셀 데이터 반환 */
function getActiveVoxelLib()        { return isLoggedIn ? dbVoxelObjects    : loadVoxelLib(); }
function getActiveVoxelPlacements() { return isLoggedIn ? dbVoxelPlacements : loadVoxelPlaced(); }

function getFloorBounds() {
  const cells = effectiveFloorCells();
  let mgx = Infinity;
  let Mgx = -Infinity;
  let mgz = Infinity;
  let Mgz = -Infinity;
  for (const c of cells) {
    mgx = Math.min(mgx, c.gx);
    Mgx = Math.max(Mgx, c.gx);
    mgz = Math.min(mgz, c.gz);
    Mgz = Math.max(Mgz, c.gz);
  }
  if (!Number.isFinite(mgx)) {
    return { cx: 0, cz: 0, sizeX: TILE_WORLD, sizeZ: TILE_WORLD };
  }
  const sizeX = (Mgx - mgx + 1) * TILE_WORLD;
  const sizeZ = (Mgz - mgz + 1) * TILE_WORLD;
  const cx = ((mgx + Mgx) / 2) * TILE_WORLD;
  const cz = ((mgz + Mgz) / 2) * TILE_WORLD;
  return { cx, cz, sizeX, sizeZ };
}

function worldToNearestCell(x, z) {
  return { gx: Math.round(x / TILE_WORLD), gz: Math.round(z / TILE_WORLD) };
}

/* ── 로그인 여부에 따라 DB or localStorage에서 타일 정보 반환 ── */
function effectiveFloorCells() {
  if (isLoggedIn) {
    const cells = dbItems
      .filter((i) => i.catId === 'floor_tile' && i.placed)
      .map((i) => ({ gx: Math.round(i.posX || 0), gz: Math.round(i.posZ || 0) }));
    return cells.length > 0 ? cells : [{ gx: 0, gz: 0 }];
  }
  return getFloorCells();
}

function effectiveFloorUnplaced() {
  if (isLoggedIn) {
    return dbItems.filter((i) => i.catId === 'floor_tile' && !i.placed).length;
  }
  return getFloorUnplaced();
}

function canPlaceFloorAt(gx, gz) {
  const cells = effectiveFloorCells();
  if (cells.some((c) => c.gx === gx && c.gz === gz)) return false;
  return cells.some((c) => Math.abs(c.gx - gx) + Math.abs(c.gz - gz) === 1);
}

function isFloorCellsConnected(cells) {
  if (cells.length <= 1) return true;
  const keySet = new Set(cells.map((c) => `${c.gx},${c.gz}`));
  const start = cells[0];
  const seen = new Set([`${start.gx},${start.gz}`]);
  const q = [start];
  while (q.length) {
    const c = q.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const gx = c.gx + dx;
      const gz = c.gz + dz;
      const k = `${gx},${gz}`;
      if (keySet.has(k) && !seen.has(k)) {
        seen.add(k);
        q.push({ gx, gz });
      }
    }
  }
  return seen.size === cells.length;
}

function hasFurnitureOnCell(gx, gz) {
  const placed = isLoggedIn ? getDbPlaced() : getGuestPlaced();
  for (const p of placed) {
    const w = worldToNearestCell(p.x, p.z);
    if (w.gx === gx && w.gz === gz) return true;
  }
  return false;
}

function getGuestWallet() {
  const v = Number(localStorage.getItem(LS.GUEST_WALLET));
  if (!Number.isFinite(v)) {
    localStorage.setItem(LS.GUEST_WALLET, String(GUEST_START_COINS));
    return GUEST_START_COINS;
  }
  return v;
}
function setGuestWallet(n) {
  localStorage.setItem(LS.GUEST_WALLET, String(Math.max(0, n)));
}

/* ── 코인 UI ────────────────────────────────────────────── */
function getDisplayBalance() {
  return isLoggedIn ? Math.max(0, serverCoins) : getGuestWallet();
}

function refreshCoinUi() {
  const bal = getDisplayBalance();
  if (coinDisplay) coinDisplay.textContent = bal.toLocaleString();
  if (serverCoinDisplay) serverCoinDisplay.textContent = isLoggedIn ? bal.toLocaleString() : '—';
  if (coinHint) {
    coinHint.textContent = isLoggedIn
      ? ''
      : '게스트: 코인은 이 브라우저에만 저장됩니다.';
  }
}

/* ── 서버 초기화 ─────────────────────────────────────────── */
async function initFromServer() {
  if (!alpToken || !platformApi) {
    isLoggedIn = false;
    refreshCoinUi();
    renderShop();
    return;
  }

  try {
    const r = await fetch(`${platformApi}/api/auth/me`, {
      headers: { Authorization: `Bearer ${alpToken}` },
    });
    const data = r.ok ? await r.json() : null;
    if (data?.user && typeof data.user.coins === 'number') {
      isLoggedIn = true;
      serverCoins = data.user.coins;
    } else {
      isLoggedIn = false;
    }
  } catch {
    isLoggedIn = false;
  }

  refreshCoinUi();
  renderShop();

  if (!isLoggedIn) {
    if (loginOverlay) loginOverlay.classList.remove('hidden');
    return;
  }

  // 가구 + 복셀 데이터 병렬 로드
  try {
    const [furnitureRes, voxelObjRes, voxelPlaceRes] = await Promise.all([
      fetch(`${platformApi}/api/furniture`,          { headers: { Authorization: `Bearer ${alpToken}` } }),
      fetch(`${platformApi}/api/voxels`,             { headers: { Authorization: `Bearer ${alpToken}` } }),
      fetch(`${platformApi}/api/voxels/placements`,  { headers: { Authorization: `Bearer ${alpToken}` } }),
    ]);

    if (furnitureRes.ok) {
      const d = await furnitureRes.json();
      dbItems = Array.isArray(d.items) ? d.items : [];
    }
    if (voxelObjRes.ok) {
      const d = await voxelObjRes.json();
      dbVoxelObjects = Array.isArray(d.objects) ? d.objects : [];
    }
    if (voxelPlaceRes.ok) {
      const d = await voxelPlaceRes.json();
      dbVoxelPlacements = Array.isArray(d.placements) ? d.placements : [];
    }

    syncSceneFromData();
    renderInventory();
    renderVoxelLibrary();
    rebuildFloorScene();
  } catch {}
}

/* ── Three.js 씬 ─────────────────────────────────────────── */
const furnitureMap = new Map();
let dragTarget = null;
const dragPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragOffset = new THREE.Vector3();
const planeHit   = new THREE.Vector3();
let raycaster = new THREE.Raycaster();
let pointer   = new THREE.Vector2();
let scene, camera, renderer, controls;
let floorGroup, floorGridHelper, sharedFloorMaterial, sharedFloorTexture;

function makeWoodFloorTexture() {
  const w = 512, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#c9b09a');
  g.addColorStop(0.5, '#b89a84');
  g.addColorStop(1, '#a88974');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const plank = Math.floor(w / 8);
  for (let i = 0; i < plank; i += 1) {
    const x = (i / plank) * w;
    ctx.strokeStyle = `rgba(62,39,35,${0.08 + (i % 3) * 0.04})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let j = 0; j < 24; j += 1) {
    const y = (j / 24) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3.2, 3.2);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildFurnitureGroup(cat) {
  const g = new THREE.Group();
  const r = Math.min(0.06, cat.w, cat.h, cat.d) * 0.12;
  const mat = new THREE.MeshStandardMaterial({
    color: cat.color,
    roughness: cat.id === 'tv' ? 0.35 : 0.58,
    metalness: cat.id === 'tv' ? 0.25 : 0.06,
  });
  const geo = new RoundedBoxGeometry(cat.w, cat.h, cat.d, 4, r);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = cat.h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  if (cat.id === 'lamp') {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 24, 24),
      new THREE.MeshStandardMaterial({
        color: 0xfff8e1, emissive: 0xffe082,
        emissiveIntensity: 1.1, roughness: 0.2, metalness: 0,
      })
    );
    bulb.position.set(0, cat.h - 0.06, 0);
    g.add(bulb);
  }
  if (cat.id === 'plant') {
    const top = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.88, metalness: 0 })
    );
    top.position.set(0, cat.h + 0.12, 0);
    g.add(top);
  }
  return g;
}

function clampToRoom(x, z) {
  const cells = effectiveFloorCells();
  if (!cells.length) return { x: 0, z: 0 };
  const inset = 0.2;
  const h = TILE_WORLD / 2 - inset;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of cells) {
    const cx = c.gx * TILE_WORLD;
    const cz = c.gz * TILE_WORLD;
    minX = Math.min(minX, cx - h);
    maxX = Math.max(maxX, cx + h);
    minZ = Math.min(minZ, cz - h);
    maxZ = Math.max(maxZ, cz + h);
  }
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    z: Math.max(minZ, Math.min(maxZ, z)),
  };
}

function setGroupFromRecord(group, p) {
  const c = clampToRoom(p.x, p.z);
  group.position.set(c.x, 0, c.z);
  group.rotation.y = typeof p.ry === 'number' ? p.ry : 0;
}

function highlightFloorSelection() {
  if (!floorGroup) return;
  if (
    selectedFloorCell &&
    !effectiveFloorCells().some(
      (c) => c.gx === selectedFloorCell.gx && c.gz === selectedFloorCell.gz
    )
  ) {
    selectedFloorCell = null;
  }
  floorGroup.children.forEach((ch) => {
    if (!ch.userData?.isFloorTile || !ch.material) return;
    const sel =
      selectedFloorCell &&
      ch.userData.floorGx === selectedFloorCell.gx &&
      ch.userData.floorGz === selectedFloorCell.gz;
    if (ch.material.emissive) {
      ch.material.emissive.setHex(sel ? 0x334466 : 0x000000);
      ch.material.emissiveIntensity = sel ? 0.45 : 0;
    }
  });
}

function highlightSelection() {
  furnitureMap.forEach((group, id) => {
    const sel = id === selectedPlaceId;
    group.traverse((ch) => {
      if (!ch.isMesh || !ch.material) return;
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      mats.forEach((m) => {
        if (m.emissive) {
          m.emissive.setHex(sel ? 0x223355 : 0x000000);
          m.emissiveIntensity = sel ? 0.4 : 0;
        }
      });
    });
  });
  highlightFloorSelection();
  btnRemoveSelected.disabled = !selectedPlaceId && !selectedFloorCell;
}

function syncSceneFromData() {
  const placed      = isLoggedIn ? getDbPlaced() : getGuestPlaced();
  const regularIds  = new Set(placed.map((p) => p.id));
  const voxPlaced   = getActiveVoxelPlacements();
  const voxIds      = new Set(voxPlaced.map((p) => p.id));
  const allIds      = new Set([...regularIds, ...voxIds]);

  furnitureMap.forEach((group, id) => {
    if (!allIds.has(id)) {
      scene.remove(group);
      furnitureMap.delete(id);
    }
  });

  placed.forEach((p) => {
    const cat = catalogById[p.catId];
    if (!cat || cat.isFloorTile) return;
    let group = furnitureMap.get(p.id);
    if (!group) {
      group = buildFurnitureGroup(cat);
      group.userData.placeId = p.id;
      group.userData.catId   = p.catId;
      scene.add(group);
      furnitureMap.set(p.id, group);
    }
    setGroupFromRecord(group, p);
  });

  // 복셀 오브젝트 배치
  const voxLib = getActiveVoxelLib();
  voxPlaced.forEach((p) => {
    // DB: p.voxelObjectId / localStorage: p.libId
    const objectId = p.voxelObjectId || p.libId;
    const libItem = voxLib.find((l) => l.id === objectId);
    if (!libItem) return;
    let group = furnitureMap.get(p.id);
    if (!group) {
      group = buildVoxelGroupForRoom(libItem.voxels || []);
      group.userData.placeId   = p.id;
      group.userData.catId     = '__voxel__';
      group.userData.libId     = objectId;
      scene.add(group);
      furnitureMap.set(p.id, group);
    }
    setGroupFromRecord(group, p);
  });

  if (selectedPlaceId && !allIds.has(selectedPlaceId)) selectedPlaceId = null;
  highlightSelection();
}

/* ── 상점 / 인벤토리 렌더 ────────────────────────────────── */
function renderShop() {
  shopList.innerHTML = '';
  const bal = getDisplayBalance();
  CATALOG.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'shop-card';
    card.innerHTML = `
      <span class="shop-emoji">${item.emoji}</span>
      <div class="shop-meta">
        <div class="name">${item.name}</div>
        <div class="price">${item.price.toLocaleString()} 코인</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-buy';
    btn.textContent = '구매';
    btn.disabled = bal < item.price;
    btn.addEventListener('click', () => buyItem(item.id));
    card.appendChild(btn);
    shopList.appendChild(card);
  });
}

function renderInventory() {
  invList.innerHTML = '';
  const inv = isLoggedIn ? getDbInventory() : getGuestInventory();
  const ft = effectiveFloorUnplaced();
  if (ft > 0) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `inv-chip${selectedCatalogId === 'floor_tile' ? ' active' : ''}`;
    chip.innerHTML = `<span class="e">⬜</span><span>바닥 타일</span><span class="cnt">×${ft}</span>`;
    chip.addEventListener('click', () => {
      selectedCatalogId = selectedCatalogId === 'floor_tile' ? null : 'floor_tile';
      selectedPlaceId = null;
      selectedFloorCell = null;
      renderInventory();
      updatePlaceHint();
      highlightSelection();
    });
    invList.appendChild(chip);
  }
  FURNITURE_CATALOG.forEach((item) => {
    const count = inv[item.id] || 0;
    if (count <= 0) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'inv-chip' + (selectedCatalogId === item.id ? ' active' : '');
    chip.innerHTML = `<span class="e">${item.emoji}</span><span>${item.name}</span><span class="cnt">×${count}</span>`;
    chip.addEventListener('click', () => {
      selectedCatalogId = selectedCatalogId === item.id ? null : item.id;
      selectedPlaceId = null;
      selectedFloorCell = null;
      renderInventory();
      updatePlaceHint();
      highlightSelection();
    });
    invList.appendChild(chip);
  });
  // 복셀 오브젝트 칩
  const voxLib = getActiveVoxelLib();
  voxLib.forEach((item) => {
    const chipId = `voxel:${item.id}`;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'inv-chip' + (selectedCatalogId === chipId ? ' active' : '');
    chip.innerHTML = `<span class="e">🎨</span><span>${item.name || '이름없음'}</span><span class="cnt">복셀</span>`;
    chip.addEventListener('click', () => {
      selectedCatalogId = selectedCatalogId === chipId ? null : chipId;
      selectedPlaceId = null; selectedFloorCell = null;
      renderInventory(); updatePlaceHint(); highlightSelection();
    });
    invList.appendChild(chip);
  });

  if (invList.children.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'panel-title';
    empty.style.opacity = '0.7';
    empty.textContent = '상점에서 가구를 먼저 구매하거나, 제작 탭에서 복셀 오브젝트를 만드세요.';
    invList.appendChild(empty);
  }
}

function updatePlaceHint() {
  roomHost.classList.toggle('placing-cursor', !!selectedCatalogId);
  if (selectedCatalogId === 'floor_tile') {
    placeHint.textContent =
      '「바닥 타일」— 이미 깔린 바닥과 옆면이 맞닿는 빈 칸을 클릭하면 확장됩니다. (시점 조작은 상단 버튼)';
    return;
  }
  if (selectedCatalogId && selectedCatalogId.startsWith('voxel:')) {
    const libId = selectedCatalogId.slice(6);
    const item = getActiveVoxelLib().find((l) => l.id === libId);
    placeHint.textContent = `「${item?.name || '복셀 오브젝트'}」 배치 — 바닥을 클릭하세요.`;
    return;
  }
  if (selectedCatalogId) {
    const it = catalogById[selectedCatalogId];
    placeHint.textContent = `「${it.name}」 배치 — 바닥을 클릭하세요. (시점 돌리기는 상단 버튼)`;
  } else {
    placeHint.textContent =
      '「내 가구」에서 가구·바닥 타일을 선택하거나, 배치된 가구를 클릭해 선택하세요. 바닥 칸을 클릭하면 타일만 선택되어 치울 수 있습니다.';
  }
}

/* ── 구매 ────────────────────────────────────────────────── */
async function buyItem(catId) {
  const item = catalogById[catId];
  if (!item) return;

  if (catId === 'floor_tile') {
    if (!isLoggedIn) {
      if (getGuestWallet() < item.price) { alert('코인이 부족합니다.'); return; }
      setGuestWallet(getGuestWallet() - item.price);
      setFloorUnplaced(getFloorUnplaced() + 1);
      refreshCoinUi();
      renderShop();
      renderInventory();
      return;
    }
    try {
      const r = await fetch(`${platformApi}/api/furniture/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
        body: JSON.stringify({ catId: 'floor_tile' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert(data?.error?.message || '구매에 실패했습니다.'); return; }
      if (typeof data.coins === 'number') serverCoins = data.coins;
      if (data.item) dbItems.push(data.item);
      refreshCoinUi();
      renderShop();
      renderInventory();
    } catch { alert('서버 오류가 발생했습니다.'); }
    return;
  }

  if (!isLoggedIn) {
    if (getGuestWallet() < item.price) { alert('코인이 부족합니다.'); return; }
    setGuestWallet(getGuestWallet() - item.price);
    const inv = getGuestInventory();
    inv[catId] = (inv[catId] || 0) + 1;
    setGuestInventory(inv);
    refreshCoinUi();
    renderShop();
    renderInventory();
    return;
  }

  // 로그인 — API
  try {
    const r = await fetch(`${platformApi}/api/furniture/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
      body: JSON.stringify({ catId }),
    });
    const data = await r.json();
    if (!r.ok) { alert(data?.error?.message || '구매에 실패했습니다.'); return; }
    dbItems.push(data.item);
    serverCoins = data.coins;
    refreshCoinUi();
    renderShop();
    renderInventory();
  } catch { alert('서버 오류가 발생했습니다.'); }
}

/* ── 배치 ────────────────────────────────────────────────── */
async function tryPlaceFloorTile(x, z) {
  if (effectiveFloorUnplaced() <= 0) return;
  const { gx, gz } = worldToNearestCell(x, z);
  if (!canPlaceFloorAt(gx, gz)) {
    alert('이미 바닥이 있거나, 기존 바닥과 옆면이 맞닿는 칸에만 늘릴 수 있습니다.');
    return;
  }

  if (!isLoggedIn) {
    setFloorUnplaced(getFloorUnplaced() - 1);
    setFloorCells([...getFloorCells(), { gx, gz }]);
    rebuildFloorScene();
    selectedCatalogId = null;
    renderInventory();
    updatePlaceHint();
    renderShop();
    return;
  }

  const unplaced = dbItems.find((i) => i.catId === 'floor_tile' && !i.placed);
  if (!unplaced) return;
  try {
    const r = await fetch(`${platformApi}/api/furniture/${unplaced.id}/place`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
      body: JSON.stringify({ posX: gx, posZ: gz, rotY: 0 }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const idx = dbItems.findIndex((i) => i.id === unplaced.id);
    if (idx >= 0) dbItems[idx] = data.item;
    rebuildFloorScene();
    selectedCatalogId = null;
    renderInventory();
    updatePlaceHint();
    renderShop();
  } catch {}
}

async function placeAtWorld(x, z) {
  if (!selectedCatalogId) return;

  if (selectedCatalogId === 'floor_tile') {
    await tryPlaceFloorTile(x, z);
    return;
  }

  if (selectedCatalogId.startsWith('voxel:')) {
    const libId = selectedCatalogId.slice(6);
    const libItem = getActiveVoxelLib().find((l) => l.id === libId);
    if (!libItem) return;
    const c = clampToRoom(x, z);

    if (isLoggedIn) {
      try {
        const r = await fetch(`${platformApi}/api/voxels/placements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
          body: JSON.stringify({ voxelObjectId: libId, posX: c.x, posZ: c.z, rotY: 0 }),
        });
        if (!r.ok) return;
        const data = await r.json();
        dbVoxelPlacements.push(data.placement);
      } catch { return; }
    } else {
      const id = `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const placed = loadVoxelPlaced();
      placed.push({ id, libId, x: c.x, z: c.z, ry: 0 });
      saveVoxelPlaced(placed);
    }

    selectedCatalogId = null;
    renderInventory(); syncSceneFromData(); updatePlaceHint();
    return;
  }

  const c = clampToRoom(x, z);

  if (!isLoggedIn) {
    const inv = getGuestInventory();
    if ((inv[selectedCatalogId] || 0) <= 0) return;
    inv[selectedCatalogId] -= 1;
    if (inv[selectedCatalogId] <= 0) delete inv[selectedCatalogId];
    setGuestInventory(inv);
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const placed = getGuestPlaced();
    placed.push({ id, catId: selectedCatalogId, x: c.x, z: c.z, ry: 0 });
    setGuestPlaced(placed);
    selectedCatalogId = null;
    renderInventory();
    syncSceneFromData();
    updatePlaceHint();
    renderShop();
    return;
  }

  const unplaced = dbItems.find(i => i.catId === selectedCatalogId && !i.placed);
  if (!unplaced) return;
  try {
    const r = await fetch(`${platformApi}/api/furniture/${unplaced.id}/place`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
      body: JSON.stringify({ posX: c.x, posZ: c.z, rotY: 0 }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const idx = dbItems.findIndex(i => i.id === unplaced.id);
    if (idx >= 0) dbItems[idx] = data.item;
    selectedCatalogId = null;
    renderInventory();
    syncSceneFromData();
    updatePlaceHint();
    renderShop();
  } catch {}
}

/* ── 드래그 위치 저장 ────────────────────────────────────── */
async function saveDraggedPosition(placeId, x, z, catId) {
  const c = clampToRoom(x, z);

  // 복셀 배치 이동
  if (catId === '__voxel__') {
    if (!isLoggedIn) {
      const placed = loadVoxelPlaced();
      const idx = placed.findIndex(p => p.id === placeId);
      if (idx >= 0) { placed[idx].x = c.x; placed[idx].z = c.z; }
      saveVoxelPlaced(placed);
    } else {
      try {
        const r = await fetch(`${platformApi}/api/voxels/placements/${placeId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
          body: JSON.stringify({ posX: c.x, posZ: c.z }),
        });
        if (r.ok) {
          const data = await r.json();
          const idx = dbVoxelPlacements.findIndex(p => p.id === placeId);
          if (idx >= 0) dbVoxelPlacements[idx] = data.placement;
        }
      } catch {}
    }
    return;
  }

  // 일반 가구 이동
  if (!isLoggedIn) {
    const placed = getGuestPlaced();
    const idx = placed.findIndex(p => p.id === placeId);
    if (idx >= 0) { placed[idx].x = c.x; placed[idx].z = c.z; }
    setGuestPlaced(placed);
    return;
  }

  try {
    const r = await fetch(`${platformApi}/api/furniture/${placeId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
      body: JSON.stringify({ posX: c.x, posZ: c.z }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const idx = dbItems.findIndex(i => i.id === placeId);
    if (idx >= 0) dbItems[idx] = data.item;
  } catch {}
}

/* ── 바닥 타일 치우기 (→ 미배치 타일) ───────────────────── */
async function tryRemoveFloorCell(gx, gz) {
  const cells = effectiveFloorCells();
  if (cells.length <= 1) {
    alert('마지막 바닥 칸은 치울 수 없습니다.');
    return;
  }
  if (!cells.some((c) => c.gx === gx && c.gz === gz)) return;

  const next = cells.filter((c) => !(c.gx === gx && c.gz === gz));
  if (!isFloorCellsConnected(next)) {
    alert('바닥이 한 덩어리가 되도록 유지해야 합니다. 다른 칸을 먼저 치우세요.');
    return;
  }
  if (hasFurnitureOnCell(gx, gz)) {
    alert('그 칸 위에 가구가 있으면 바닥을 치울 수 없습니다.');
    return;
  }

  if (!isLoggedIn) {
    setFloorCells(next);
    setFloorUnplaced(getFloorUnplaced() + 1);
    selectedFloorCell = null;
    rebuildFloorScene();
    syncSceneFromData();
    renderInventory();
    updatePlaceHint();
    highlightSelection();
    return;
  }

  const item = dbItems.find(
    (i) => i.catId === 'floor_tile' && i.placed &&
      Math.round(i.posX ?? 0) === gx && Math.round(i.posZ ?? 0) === gz
  );
  if (!item) { alert('이 바닥 칸은 서버에 저장된 타일이 아니어서 치울 수 없습니다.'); return; }

  try {
    const r = await fetch(`${platformApi}/api/furniture/${item.id}/remove`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${alpToken}` },
    });
    if (!r.ok) return;
    const data = await r.json();
    const idx = dbItems.findIndex((i) => i.id === item.id);
    if (idx >= 0) dbItems[idx] = data.item;
    selectedFloorCell = null;
    rebuildFloorScene();
    syncSceneFromData();
    renderInventory();
    updatePlaceHint();
    highlightSelection();
  } catch {}
}

/* ── 치우기 (방 → 내 가구 / 바닥 타일) ──────────────────── */
btnRemoveSelected.addEventListener('click', async () => {
  if (selectedFloorCell) {
    await tryRemoveFloorCell(selectedFloorCell.gx, selectedFloorCell.gz);
    return;
  }
  if (!selectedPlaceId) return;

  // 복셀 배치 아이템 제거
  const isVoxelPlaced = getActiveVoxelPlacements().some((p) => p.id === selectedPlaceId);
  if (isVoxelPlaced) {
    const pid = selectedPlaceId;
    if (isLoggedIn) {
      try {
        const r = await fetch(`${platformApi}/api/voxels/placements/${pid}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${alpToken}` },
        });
        if (!r.ok) return;
        dbVoxelPlacements = dbVoxelPlacements.filter(p => p.id !== pid);
      } catch { return; }
    } else {
      saveVoxelPlaced(loadVoxelPlaced().filter(p => p.id !== pid));
    }
    selectedPlaceId = null;
    syncSceneFromData(); renderInventory(); updatePlaceHint(); highlightSelection();
    return;
  }

  if (!isLoggedIn) {
    const placed = getGuestPlaced();
    const removed = placed.find(p => p.id === selectedPlaceId);
    if (removed) {
      const inv = getGuestInventory();
      inv[removed.catId] = (inv[removed.catId] || 0) + 1;
      setGuestInventory(inv);
    }
    setGuestPlaced(placed.filter(p => p.id !== selectedPlaceId));
    selectedPlaceId = null;
    syncSceneFromData();
    renderInventory();
    updatePlaceHint();
    return;
  }

  const id = selectedPlaceId;
  try {
    const r = await fetch(`${platformApi}/api/furniture/${id}/remove`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${alpToken}` },
    });
    if (!r.ok) return;
    const data = await r.json();
    const idx = dbItems.findIndex(i => i.id === id);
    if (idx >= 0) dbItems[idx] = data.item;
    selectedPlaceId = null;
    syncSceneFromData();
    renderInventory();
    updatePlaceHint();
  } catch {}
});

/* ── Three.js 초기화 ─────────────────────────────────────── */
function getIntersects(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(scene.children, true);
}

function pickFurnitureFromIntersects(intersects) {
  for (let i = 0; i < intersects.length; i += 1) {
    let o = intersects[i].object;
    while (o) {
      if (o.userData && o.userData.placeId) return o;
      o = o.parent;
    }
  }
  return null;
}

function rebuildFloorScene() {
  if (!floorGroup || !scene) return;
  while (floorGroup.children.length > 0) {
    const ch = floorGroup.children[0];
    ch.geometry?.dispose();
    if (ch.material && ch.material !== sharedFloorMaterial) ch.material.dispose();
    floorGroup.remove(ch);
  }
  if (!sharedFloorMaterial) {
    sharedFloorTexture = makeWoodFloorTexture();
    sharedFloorMaterial = new THREE.MeshStandardMaterial({
      map: sharedFloorTexture,
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.04,
    });
  }
  for (const c of effectiveFloorCells()) {
    const mat = sharedFloorMaterial.clone();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(TILE_WORLD, TILE_WORLD), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(c.gx * TILE_WORLD, 0, c.gz * TILE_WORLD);
    mesh.receiveShadow = true;
    mesh.userData.isFloorTile = true;
    mesh.userData.floorGx = c.gx;
    mesh.userData.floorGz = c.gz;
    floorGroup.add(mesh);
  }
  highlightFloorSelection();

  if (floorGridHelper) {
    scene.remove(floorGridHelper);
    floorGridHelper.geometry?.dispose();
    const gm = floorGridHelper.material;
    if (Array.isArray(gm)) gm.forEach((m) => m.dispose?.());
    else gm?.dispose?.();
    floorGridHelper = null;
  }
  const b = getFloorBounds();
  const size = Math.max(TILE_WORLD * 1.2, b.sizeX, b.sizeZ) + TILE_WORLD * 0.2;
  const divisions = Math.max(4, Math.round(size / TILE_WORLD) * 4);
  floorGridHelper = new THREE.GridHelper(size, divisions, 0xa89f97, 0xc4bbb3);
  const gmats = Array.isArray(floorGridHelper.material)
    ? floorGridHelper.material
    : [floorGridHelper.material];
  gmats.forEach((m) => {
    m.transparent = true;
    m.opacity = 0.32;
  });
  floorGridHelper.position.set(b.cx, 0.002, b.cz);
  scene.add(floorGridHelper);
}

function onPointerDown(ev) {
  if (controls.enabled) return;
  if (performance.now() - lastDragEndTime < 180) return;
  const intersects = getIntersects(ev.clientX, ev.clientY);
  const furnitureHit = pickFurnitureFromIntersects(intersects);
  if (furnitureHit) {
    let root = furnitureHit;
    while (root.parent && !root.userData.placeId) root = root.parent;
    if (!root.userData.placeId) return;
    dragTarget = root;
    selectedPlaceId = root.userData.placeId;
    selectedCatalogId = null;
    selectedFloorCell = null;
    renderInventory();
    updatePlaceHint();
    highlightSelection();
    if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
      dragOffset.set(
        dragTarget.position.x - planeHit.x, 0,
        dragTarget.position.z - planeHit.z
      );
    }
    ev.preventDefault();
    return;
  }
  selectedPlaceId = null;
  highlightSelection();
  if (!selectedCatalogId) {
    const floorPick = intersects.find((h) => h.object.userData?.isFloorTile);
    if (floorPick && Number.isFinite(floorPick.object.userData.floorGx)) {
      selectedFloorCell = {
        gx: floorPick.object.userData.floorGx,
        gz: floorPick.object.userData.floorGz,
      };
      highlightSelection();
      ev.preventDefault();
      return;
    }
    selectedFloorCell = null;
    highlightSelection();
    return;
  }
  const floorHit = intersects.find((h) => h.object.userData?.isFloorTile);
  if (floorHit) {
    placeAtWorld(floorHit.point.x, floorHit.point.z);
  } else if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
    placeAtWorld(planeHit.x, planeHit.z);
  }
}

function onPointerMove(ev) {
  if (!dragTarget || controls.enabled) return;
  getIntersects(ev.clientX, ev.clientY);
  if (!raycaster.ray.intersectPlane(dragPlane, planeHit)) return;
  const nx = planeHit.x + dragOffset.x;
  const nz = planeHit.z + dragOffset.z;
  const c = clampToRoom(nx, nz);
  dragTarget.position.set(c.x, 0, c.z);
  dragTarget.userData.moved = true;
}

function onPointerUp() {
  if (dragTarget && dragTarget.userData.moved) {
    saveDraggedPosition(
      dragTarget.userData.placeId,
      dragTarget.position.x,
      dragTarget.position.z,
      dragTarget.userData.catId,
    );
    lastDragEndTime = performance.now();
  }
  if (dragTarget) dragTarget.userData.moved = false;
  dragTarget = null;
}

function initThree() {
  scene = new THREE.Scene();
  const sky = 0xf5f2eb;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, 22, 48);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(5.2, 5.8, 7.2);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  roomHost.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.4, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 18;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.enabled = false;

  scene.add(new THREE.AmbientLight(0xffffff, 0.52));
  scene.add(new THREE.HemisphereLight(0xeef4ff, 0xe8dfd6, 0.48));
  const sun = new THREE.DirectionalLight(0xfffbf5, 1.18);
  sun.position.set(5.5, 11, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 32;
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8;  sun.shadow.camera.bottom = -8;
  scene.add(sun);

  floorGroup = new THREE.Group();
  scene.add(floorGroup);
  rebuildFloorScene();

  function resize() {
    const w = roomHost.clientWidth, h = roomHost.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  resize();
  window.addEventListener('resize', resize);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

/* ── 시점 조작 버튼 ──────────────────────────────────────── */
const btnOrbit = document.createElement('button');
btnOrbit.type = 'button';
btnOrbit.className = 'btn-orbit';
btnOrbit.textContent = '시점 조작 켜기 (회전·확대)';
btnOrbit.setAttribute('aria-pressed', 'false');
btnOrbit.addEventListener('click', () => {
  const on = !controls.enabled;
  controls.enabled = on;
  btnOrbit.textContent = on ? '시점 조작 끄기 (가구 배치)' : '시점 조작 켜기 (회전·확대)';
  btnOrbit.setAttribute('aria-pressed', on ? 'true' : 'false');
  roomHost.classList.toggle('orbit-mode', on);
  if (on) {
    selectedCatalogId = null;
    selectedFloorCell = null;
    renderInventory();
    updatePlaceHint();
    highlightSelection();
  }
});
roomHost.parentElement.insertBefore(btnOrbit, placeHint);

/* ═══════════════════════════════════════════════════════════
   복셀 에디터
═══════════════════════════════════════════════════════════ */

/* ── 복셀 등록 수수료 ───────────────────────────────────── */
function calcVoxelFee(price) {
  // 판매 가격의 15%, 최소 5 코인
  return Math.max(5, Math.ceil(price * 0.15));
}

function updateVoxelFeeDisplay() {
  const el = document.getElementById('voxelFeeInfo');
  if (!el) return;
  const raw   = parseInt(document.getElementById('voxelPrice')?.value) || 100;
  const price = Math.max(1, Math.min(9999, raw));
  const fee   = calcVoxelFee(price);
  const bal   = getDisplayBalance();
  const after = bal - fee;
  const short = after < 0;
  const label = voxelEditingLibId ? '✏️ 수정 수수료' : '📋 등록 수수료';

  el.className = 'voxel-fee-info' + (short ? ' insufficient' : '');
  el.innerHTML = `
    <div class="fee-row">
      <span class="fee-key">${label}</span>
      <span class="fee-val">−${fee.toLocaleString()} 코인 <span style="font-weight:normal;opacity:.7">(15%)</span></span>
    </div>
    <div class="fee-balance-row${short ? ' danger' : ''}">
      <span>잔액 ${bal.toLocaleString()}</span>
      <span class="fee-arrow">→</span>
      <span class="fee-after">${short ? '⚠️ 코인 부족' : after.toLocaleString() + ' 코인'}</span>
    </div>`;

  const btnSave = document.getElementById('btnVoxelSave');
  if (btnSave) btnSave.disabled = short;
}

/* 방 렌더용 복셀 Group */
function buildVoxelGroupForRoom(voxels) {
  const g = new THREE.Group();
  const matCache = new Map();
  for (const v of voxels) {
    let mat = matCache.get(v.color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(v.color), roughness: 0.72, metalness: 0.06 });
      matCache.set(v.color, mat);
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(VOXEL_SCALE, VOXEL_SCALE, VOXEL_SCALE), mat);
    mesh.position.set(v.x * VOXEL_SCALE, v.y * VOXEL_SCALE + VOXEL_SCALE / 2, v.z * VOXEL_SCALE);
    mesh.castShadow = true;
    g.add(mesh);
  }
  return g;
}

function voxelMapToArray(map) {
  const arr = [];
  map.forEach((color, key) => {
    const [x, y, z] = key.split(',').map(Number);
    arr.push({ x, y, z, color });
  });
  return arr;
}
function arrayToVoxelMap(arr) {
  const m = new Map();
  for (const v of arr) m.set(`${v.x},${v.y},${v.z}`, v.color);
  return m;
}

/* ── 에디터 상태 ────────────────────────────────────────── */
let voxelMap          = new Map();
let voxelHistory      = [];
let voxelCurrentColor = PALETTE_COLORS[3];
let voxelEditorOpen   = false;
let voxelEditingLibId = null;

/* ── 에디터 Three.js ─────────────────────────────────────── */
let vScene, vCamera, vRenderer, vControls;
let vVoxelGroup, vGhost;
let vRaycaster = new THREE.Raycaster();
let vPointer   = new THREE.Vector2();
let vEditorOrbit = false;
const VOXEL_GEO_UNIT = new THREE.BoxGeometry(1, 1, 1);

function rebuildVoxelEditorScene() {
  if (!vVoxelGroup) return;
  while (vVoxelGroup.children.length) vVoxelGroup.remove(vVoxelGroup.children[0]);
  voxelMap.forEach((color, key) => {
    const [x, y, z] = key.split(',').map(Number);
    const mesh = new THREE.Mesh(
      VOXEL_GEO_UNIT,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.7, metalness: 0.05 })
    );
    mesh.position.set(x, y, z);
    mesh.userData.isVoxel = true;
    mesh.userData.vKey = key;
    vVoxelGroup.add(mesh);
  });
  const el = document.getElementById('voxelCountText');
  if (el) el.textContent = `(${voxelMap.size}개)`;
}

function initVoxelEditorThree() {
  if (vRenderer) return;
  const wrap = document.getElementById('voxelCanvasWrap');
  if (!wrap) return;

  const vSky = 0xeceaf2;
  vScene = new THREE.Scene();
  vScene.background = new THREE.Color(vSky);
  vScene.fog = new THREE.Fog(vSky, 85, 160);

  vCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  vCamera.position.set(VOXEL_GRID * 0.9, VOXEL_GRID * 0.75, VOXEL_GRID * 1.1);
  vCamera.lookAt(VOXEL_GRID / 2, VOXEL_GRID / 4, VOXEL_GRID / 2);

  vRenderer = new THREE.WebGLRenderer({ antialias: true });
  vRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  vRenderer.outputColorSpace = THREE.SRGBColorSpace;
  vRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  vRenderer.toneMappingExposure = 1.2;
  vRenderer.shadowMap.enabled = true;
  vRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  wrap.appendChild(vRenderer.domElement);

  vControls = new OrbitControls(vCamera, vRenderer.domElement);
  vControls.target.set(VOXEL_GRID / 2, VOXEL_GRID / 4, VOXEL_GRID / 2);
  vControls.enableDamping = true;
  vControls.dampingFactor = 0.1;
  vControls.minDistance = 5;
  vControls.maxDistance = 100;
  vControls.enabled = false;

  vScene.add(new THREE.AmbientLight(0xffffff, 0.62));
  vScene.add(new THREE.HemisphereLight(0xe8eeff, 0xd8d4e4, 0.45));
  const vSun = new THREE.DirectionalLight(0xfffbf5, 1.38);
  vSun.position.set(20, 40, 20); vSun.castShadow = true;
  vScene.add(vSun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(VOXEL_GRID, VOXEL_GRID),
    new THREE.MeshStandardMaterial({ color: 0xb8b3c9, roughness: 0.88, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(VOXEL_GRID / 2 - 0.5, -0.5, VOXEL_GRID / 2 - 0.5);
  floor.receiveShadow = true;
  floor.userData.isEditorFloor = true;
  vScene.add(floor);

  const grid = new THREE.GridHelper(VOXEL_GRID, VOXEL_GRID, 0x8f85a8, 0x6f6688);
  grid.position.set(VOXEL_GRID / 2 - 0.5, -0.5, VOXEL_GRID / 2 - 0.5);
  const gm = Array.isArray(grid.material) ? grid.material : [grid.material];
  gm.forEach(m => { m.transparent = true; m.opacity = 0.38; });
  vScene.add(grid);

  vVoxelGroup = new THREE.Group();
  vScene.add(vVoxelGroup);

  vGhost = new THREE.Mesh(
    VOXEL_GEO_UNIT,
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false })
  );
  vGhost.visible = false;
  vScene.add(vGhost);

  function vResize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    vCamera.aspect = w / h;
    vCamera.updateProjectionMatrix();
    vRenderer.setSize(w, h);
  }
  vResize();
  window.addEventListener('resize', vResize);

  vRenderer.domElement.addEventListener('pointermove', onVoxelPointerMove);
  vRenderer.domElement.addEventListener('pointerdown', onVoxelPointerDown);
  vRenderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
}

function getVoxelHits(clientX, clientY) {
  if (!vRenderer || !vScene || !vCamera) return [];
  const rect = vRenderer.domElement.getBoundingClientRect();
  vPointer.x = ((clientX - rect.left) / rect.width)  * 2 - 1;
  vPointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  vRaycaster.setFromCamera(vPointer, vCamera);
  return vRaycaster.intersectObjects(vScene.children, true);
}

function resolveVoxelCell(clientX, clientY, removeMode) {
  const hits = getVoxelHits(clientX, clientY);
  const voxHit   = hits.find(h => h.object.userData?.isVoxel);
  const floorHit = hits.find(h => h.object.userData?.isEditorFloor);
  if (voxHit) {
    const p = voxHit.object.position;
    if (removeMode) return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), remove: true };
    const n = voxHit.face.normal.clone().round();
    return { x: Math.round(p.x + n.x), y: Math.round(p.y + n.y), z: Math.round(p.z + n.z), remove: false };
  }
  if (floorHit && !removeMode) {
    return { x: Math.round(floorHit.point.x), y: 0, z: Math.round(floorHit.point.z), remove: false };
  }
  return null;
}

function onVoxelPointerMove(ev) {
  if (vEditorOrbit || !vGhost) return;
  const cell = resolveVoxelCell(ev.clientX, ev.clientY, false);
  if (cell && cell.x >= 0 && cell.x < VOXEL_GRID && cell.y >= 0 && cell.y < VOXEL_GRID && cell.z >= 0 && cell.z < VOXEL_GRID) {
    vGhost.visible = true;
    vGhost.position.set(cell.x, cell.y, cell.z);
    vGhost.material.color.set(voxelCurrentColor);
  } else {
    vGhost.visible = false;
  }
}

function onVoxelPointerDown(ev) {
  if (vEditorOrbit) return;
  ev.preventDefault();
  const removeMode = ev.button === 2;
  const cell = resolveVoxelCell(ev.clientX, ev.clientY, removeMode);
  if (!cell) return;
  const { x, y, z } = cell;
  if (x < 0 || x >= VOXEL_GRID || y < 0 || y >= VOXEL_GRID || z < 0 || z >= VOXEL_GRID) return;

  voxelHistory.push(new Map(voxelMap));
  if (voxelHistory.length > 60) voxelHistory.shift();

  if (removeMode || cell.remove) voxelMap.delete(`${x},${y},${z}`);
  else                           voxelMap.set(`${x},${y},${z}`, voxelCurrentColor);
  rebuildVoxelEditorScene();
}

/* ── 팔레트 ─────────────────────────────────────────────── */
function setupVoxelPalette() {
  const container = document.getElementById('voxelPalette');
  if (!container) return;
  container.innerHTML = '';
  PALETTE_COLORS.forEach((color) => {
    const sw = document.createElement('button');
    sw.className = 'voxel-swatch' + (color === voxelCurrentColor ? ' active' : '');
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener('click', () => {
      voxelCurrentColor = color;
      container.querySelectorAll('.voxel-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      const picker = document.getElementById('voxelCustomColor');
      if (picker) picker.value = color;
    });
    container.appendChild(sw);
  });
}

/* ── 미리보기 캔버스 (2D 등각) ──────────────────────────── */
function drawVoxelPreview(canvas, voxels) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 48, 48);
  ctx.fillStyle = '#2a2630';
  ctx.fillRect(0, 0, 48, 48);
  if (!voxels.length) return;
  let mx = 0, my = 0, mz = 0;
  voxels.forEach(v => { mx = Math.max(mx, v.x); my = Math.max(my, v.y); mz = Math.max(mz, v.z); });
  const sc = 12 / Math.max(1, mx, my, mz);
  const sorted = [...voxels].sort((a, b) => (a.x + a.z) - (b.x + b.z));
  sorted.forEach(v => {
    const px = 24 + (v.x - v.z) * 2.5 * sc;
    const py = 32 - v.y * 3.5 * sc + (v.x + v.z) * 1.2 * sc;
    const s = Math.max(2, 3 * sc);
    ctx.fillStyle = v.color;
    ctx.fillRect(px - s / 2, py - s / 2, s, s);
  });
}

/* ── 복셀 라이브러리 렌더 ───────────────────────────────── */
function renderVoxelLibrary() {
  const container = document.getElementById('voxelLibraryList');
  if (!container) return;
  container.innerHTML = '';
  const lib = getActiveVoxelLib();
  if (!lib.length) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:.82rem;opacity:.6;margin:.3rem 0;';
    p.textContent = '아직 만든 오브젝트가 없어요. 위 버튼으로 시작하세요!';
    container.appendChild(p);
    return;
  }
  lib.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'voxel-lib-card';

    const previewWrap = document.createElement('div');
    previewWrap.className = 'voxel-lib-preview';
    const pc = document.createElement('canvas');
    pc.width = 48; pc.height = 48;
    previewWrap.appendChild(pc);
    drawVoxelPreview(pc, item.voxels || []);

    const meta = document.createElement('div');
    meta.className = 'voxel-lib-meta';
    meta.innerHTML = `<div class="name">${item.name || '이름없음'}</div>
      <div class="price">💰 ${(item.price || 0).toLocaleString()}</div>
      <div class="cnt">${(item.voxels || []).length}개 복셀</div>`;

    const actions = document.createElement('div');
    actions.className = 'voxel-lib-actions';

    const btnPlace = document.createElement('button');
    btnPlace.className = 'btn-lib-place'; btnPlace.textContent = '배치';
    btnPlace.addEventListener('click', () => {
      selectedCatalogId = `voxel:${item.id}`;
      selectedPlaceId = null; selectedFloorCell = null;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'inv'));
      shopPanel.classList.add('hidden');
      invPanel.classList.remove('hidden');
      createPanel.classList.add('hidden');
      renderInventory(); updatePlaceHint(); highlightSelection();
    });

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-lib-edit'; btnEdit.textContent = '수정';
    btnEdit.addEventListener('click', () => openVoxelEditor(item.id));

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-lib-del'; btnDel.textContent = '삭제';
    btnDel.addEventListener('click', async () => {
      if (!confirm(`「${item.name}」을 삭제하시겠습니까?`)) return;
      if (isLoggedIn) {
        try {
          const r = await fetch(`${platformApi}/api/voxels/${item.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${alpToken}` },
          });
          if (!r.ok) { alert('삭제에 실패했습니다.'); return; }
          dbVoxelObjects    = dbVoxelObjects.filter(v => v.id !== item.id);
          dbVoxelPlacements = dbVoxelPlacements.filter(p => p.voxelObjectId !== item.id);
        } catch { alert('서버 오류가 발생했습니다.'); return; }
      } else {
        saveVoxelLib(loadVoxelLib().filter(v => v.id !== item.id));
        saveVoxelPlaced(loadVoxelPlaced().filter(p => p.libId !== item.id));
      }
      syncSceneFromData(); renderVoxelLibrary(); renderInventory();
    });

    actions.appendChild(btnPlace);
    actions.appendChild(btnEdit);
    actions.appendChild(btnDel);
    card.appendChild(previewWrap); card.appendChild(meta); card.appendChild(actions);
    container.appendChild(card);
  });
}

/* ── 에디터 열기 / 닫기 ─────────────────────────────────── */
function openVoxelEditor(libId = null) {
  voxelEditorOpen   = true;
  voxelEditingLibId = libId;
  voxelHistory      = [];
  vEditorOrbit      = false;
  if (vControls) vControls.enabled = false;
  const ob = document.getElementById('btnVoxelOrbit');
  if (ob) { ob.textContent = '시점 조작 켜기'; ob.setAttribute('aria-pressed', 'false'); }

  document.getElementById('voxelEditorModal').classList.remove('hidden');

  if (libId) {
    const item = getActiveVoxelLib().find(v => v.id === libId);
    voxelMap = item ? arrayToVoxelMap(item.voxels || []) : new Map();
    document.getElementById('voxelName').value  = item?.name  || '';
    document.getElementById('voxelPrice').value = item?.price || 100;
  } else {
    voxelMap = new Map();
    document.getElementById('voxelName').value  = '';
    document.getElementById('voxelPrice').value = 100;
  }

  initVoxelEditorThree();
  rebuildVoxelEditorScene();
  setupVoxelPalette();
  updateVoxelFeeDisplay();

  // 가격 입력 시 수수료 실시간 갱신 (매번 새 리스너 중복 방지)
  const priceInput = document.getElementById('voxelPrice');
  if (priceInput) {
    priceInput.oninput = updateVoxelFeeDisplay;
  }

  // Force resize after layout (modal was hidden so clientWidth was 0)
  requestAnimationFrame(() => {
    const wrap = document.getElementById('voxelCanvasWrap');
    if (wrap && vRenderer && vCamera) {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w > 0 && h > 0) {
        vCamera.aspect = w / h;
        vCamera.updateProjectionMatrix();
        vRenderer.setSize(w, h);
      }
    }
  });

  // animation loop
  (function vLoop() {
    if (!voxelEditorOpen) return;
    requestAnimationFrame(vLoop);
    if (vEditorOrbit && vControls) vControls.update();
    if (vRenderer && vScene && vCamera) vRenderer.render(vScene, vCamera);
  })();
}

function closeVoxelEditor() {
  voxelEditorOpen = false;
  document.getElementById('voxelEditorModal').classList.add('hidden');
  if (vGhost) vGhost.visible = false;
}

/* ── 에디터 버튼 이벤트 ─────────────────────────────────── */
document.getElementById('btnNewVoxel').addEventListener('click', () => openVoxelEditor(null));
document.getElementById('btnVoxelClose').addEventListener('click', closeVoxelEditor);

document.getElementById('btnVoxelOrbit').addEventListener('click', () => {
  vEditorOrbit = !vEditorOrbit;
  if (vControls) vControls.enabled = vEditorOrbit;
  const btn = document.getElementById('btnVoxelOrbit');
  btn.textContent = vEditorOrbit ? '시점 조작 끄기' : '시점 조작 켜기';
  btn.setAttribute('aria-pressed', vEditorOrbit ? 'true' : 'false');
  if (vGhost) vGhost.visible = false;
});

document.getElementById('btnVoxelUndo').addEventListener('click', () => {
  if (!voxelHistory.length) return;
  voxelMap = voxelHistory.pop();
  rebuildVoxelEditorScene();
});

document.getElementById('btnVoxelClear').addEventListener('click', () => {
  if (!confirm('모든 복셀을 초기화하겠습니까?')) return;
  voxelHistory.push(new Map(voxelMap));
  voxelMap = new Map();
  rebuildVoxelEditorScene();
});

document.getElementById('voxelCustomColor').addEventListener('input', (e) => {
  voxelCurrentColor = e.target.value;
  document.querySelectorAll('.voxel-swatch').forEach(s => s.classList.remove('active'));
});

document.getElementById('btnVoxelSave').addEventListener('click', async () => {
  const name  = document.getElementById('voxelName').value.trim();
  const price = Math.max(1, Math.min(9999, parseInt(document.getElementById('voxelPrice').value) || 100));
  if (!name)          { alert('이름을 입력해 주세요.'); return; }
  if (!voxelMap.size) { alert('복셀을 하나 이상 추가해 주세요.'); return; }

  // 수수료 확인 (클라이언트 side — 서버도 재검증함)
  const fee = calcVoxelFee(price);
  const bal = getDisplayBalance();
  if (bal < fee) {
    alert(`코인이 부족합니다.\n등록 수수료 ${fee.toLocaleString()} 코인이 필요해요. (현재 ${bal.toLocaleString()} 코인)`);
    return;
  }

  const voxels = voxelMapToArray(voxelMap);
  const btnSave = document.getElementById('btnVoxelSave');
  btnSave.disabled = true;
  btnSave.textContent = '저장 중…';

  if (isLoggedIn) {
    // ── 서버 저장 ──
    try {
      const isEdit = !!voxelEditingLibId;
      const url    = isEdit
        ? `${platformApi}/api/voxels/${voxelEditingLibId}`
        : `${platformApi}/api/voxels`;
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alpToken}` },
        body: JSON.stringify({ name, price, voxels }),
      });
      const data = await r.json();
      if (!r.ok) {
        alert(data?.error?.message || '저장에 실패했습니다.');
        btnSave.disabled = false; btnSave.textContent = '💾 저장하기';
        return;
      }
      // 로컬 DB 배열 갱신
      if (isEdit) {
        const idx = dbVoxelObjects.findIndex(v => v.id === voxelEditingLibId);
        if (idx >= 0) dbVoxelObjects[idx] = data.object;
        else dbVoxelObjects.push(data.object);
      } else {
        dbVoxelObjects.push(data.object);
      }
      // 서버가 반환한 실제 코인으로 갱신
      if (typeof data.coins === 'number') serverCoins = data.coins;
    } catch {
      alert('서버 오류가 발생했습니다.');
      btnSave.disabled = false; btnSave.textContent = '💾 저장하기';
      return;
    }
  } else {
    // ── 게스트: localStorage 저장 + 코인 차감 ──
    setGuestWallet(getGuestWallet() - fee);
    const lib = loadVoxelLib();
    if (voxelEditingLibId) {
      const idx = lib.findIndex(v => v.id === voxelEditingLibId);
      const entry = { id: voxelEditingLibId, name, price, voxels };
      if (idx >= 0) lib[idx] = entry; else lib.push(entry);
    } else {
      lib.push({ id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, price, voxels });
    }
    saveVoxelLib(lib);
  }

  refreshCoinUi();
  renderShop();
  closeVoxelEditor();
  btnSave.disabled = false; btnSave.textContent = '💾 저장하기';

  // 제작 탭으로 전환
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'create'));
  shopPanel.classList.add('hidden'); invPanel.classList.add('hidden'); createPanel.classList.remove('hidden');
  renderVoxelLibrary();
  renderInventory();
});

/* ── 탭 전환 ─────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    shopPanel.classList.toggle('hidden', id !== 'shop');
    invPanel.classList.toggle('hidden', id !== 'inv');
    createPanel.classList.toggle('hidden', id !== 'create');
    if (id === 'create') renderVoxelLibrary();
  });
});

/* ── 시작 ────────────────────────────────────────────────── */
initThree();
renderShop();
renderInventory();
updatePlaceHint();
animate();

initFromServer();      // 비동기: 로그인 확인 후 DB 데이터 로드
