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
};

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

/* ── 플랫폼 연동 ──────────────────────────────────────── */
const urlParams   = new URLSearchParams(window.location.search);
const alpToken    = urlParams.get('token');
const platformApi = window.__ALP_PLATFORM_API__ || '';

let isLoggedIn      = false;
let serverCoins     = 0;
let selectedPlaceId = null;   // DB id 또는 게스트 placeId
let selectedCatalogId = null;
let lastDragEndTime = 0;

/* ── DB 가구 상태 (로그인 시) ───────────────────────────── */
// [{ id, catId, placed, posX, posZ, rotY, purchasedAt }]
let dbItems = [];

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
    // 로그인 안 된 경우 오버레이 표시
    if (loginOverlay) loginOverlay.classList.remove('hidden');
    return;
  }

  // 가구 데이터 로드
  try {
    const r = await fetch(`${platformApi}/api/furniture`, {
      headers: { Authorization: `Bearer ${alpToken}` },
    });
    if (!r.ok) return;
    const data = await r.json();
    dbItems = Array.isArray(data.items) ? data.items : [];
    syncSceneFromData();
    renderInventory();
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
  btnRemoveSelected.disabled = !selectedPlaceId;
}

function syncSceneFromData() {
  const placed = isLoggedIn ? getDbPlaced() : getGuestPlaced();
  const ids = new Set(placed.map((p) => p.id));

  furnitureMap.forEach((group, id) => {
    if (!ids.has(id)) {
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

  if (selectedPlaceId && !ids.has(selectedPlaceId)) selectedPlaceId = null;
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
      renderInventory();
      updatePlaceHint();
      highlightSelection();
    });
    invList.appendChild(chip);
  });
  if (invList.children.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'panel-title';
    empty.style.opacity = '0.7';
    empty.textContent = '상점에서 가구를 먼저 구매하세요.';
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
  if (selectedCatalogId) {
    const it = catalogById[selectedCatalogId];
    placeHint.textContent = `「${it.name}」 배치 — 바닥을 클릭하세요. (시점 돌리기는 상단 버튼)`;
  } else {
    placeHint.textContent = '「내 가구」에서 가구를 선택하거나, 배치된 가구를 클릭해 선택하세요.';
  }
}

/* ── 구매 ────────────────────────────────────────────────── */
async function buyItem(catId) {
  const item = catalogById[catId];
  if (!item) return;

  if (catId === 'floor_tile') {
    if (!isLoggedIn) {
      if (getGuestWallet() < item.price) {
        alert('코인이 부족합니다.');
        return;
      }
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
      if (!r.ok) {
        alert(data?.error?.message || '바닥 타일 구매에 실패했습니다. 서버에 상품이 등록되지 않았을 수 있습니다.');
        return;
      }
      if (typeof data.coins === 'number') serverCoins = data.coins;
      if (data.item) dbItems.push(data.item); // DB에서 수량 관리
      refreshCoinUi();
      renderShop();
      renderInventory();
    } catch {
      alert('서버 오류가 발생했습니다.');
    }
    return;
  }

  if (!isLoggedIn) {
    // 게스트 모드
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
    // 게스트 — localStorage
    setFloorUnplaced(getFloorUnplaced() - 1);
    setFloorCells([...getFloorCells(), { gx, gz }]);
    rebuildFloorScene();
    selectedCatalogId = null;
    renderInventory();
    updatePlaceHint();
    renderShop();
    return;
  }

  // 로그인 — DB (posX=gx, posZ=gz로 그리드 좌표 저장)
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

  const c = clampToRoom(x, z);

  if (!isLoggedIn) {
    // 게스트 모드
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

  // 로그인 — 미배치 아이템 중 하나를 선택해 배치
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
async function saveDraggedPosition(placeId, x, z) {
  const c = clampToRoom(x, z);

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

/* ── 치우기 (방 → 내 가구) ──────────────────────────────── */
btnRemoveSelected.addEventListener('click', async () => {
  if (!selectedPlaceId) return;

  if (!isLoggedIn) {
    // 게스트 — 인벤토리로 복귀
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

  // 로그인 — API
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
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_WORLD, TILE_WORLD),
      sharedFloorMaterial
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(c.gx * TILE_WORLD, 0, c.gz * TILE_WORLD);
    mesh.receiveShadow = true;
    mesh.userData.isFloorTile = true;
    floorGroup.add(mesh);
  }

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
  if (!selectedCatalogId) return;
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
    saveDraggedPosition(dragTarget.userData.placeId, dragTarget.position.x, dragTarget.position.z);
    lastDragEndTime = performance.now();
  }
  if (dragTarget) dragTarget.userData.moved = false;
  dragTarget = null;
}

function initThree() {
  scene = new THREE.Scene();
  const sky = 0xe8e4dc;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, 12, 26);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(5.2, 5.8, 7.2);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
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

  scene.add(new THREE.AmbientLight(0xf5f0ff, 0.42));
  scene.add(new THREE.HemisphereLight(0xe3f0ff, 0xc9b8a8, 0.38));
  const sun = new THREE.DirectionalLight(0xfff6e9, 1.05);
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
  if (on) { selectedCatalogId = null; renderInventory(); updatePlaceHint(); }
});
roomHost.parentElement.insertBefore(btnOrbit, placeHint);

/* ── 탭 전환 ─────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    shopPanel.classList.toggle('hidden', id !== 'shop');
    invPanel.classList.toggle('hidden', id !== 'inv');
  });
});

/* ── 시작 ────────────────────────────────────────────────── */
initThree();
renderShop();
renderInventory();
updatePlaceHint();
animate();

initFromServer();      // 비동기: 로그인 확인 후 DB 데이터 로드
