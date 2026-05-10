import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const LS = {
  PLACED: 'sg4_placed_v2',
  PLACED_LEGACY: 'sg4_placed_v1',
  INV: 'sg4_inv_v1',
  SPENT: 'sg4_spent_v1',
  GUEST_WALLET: 'sg4_guest_wallet_v1',
};

const GUEST_START_COINS = 1200;
const ROOM_HALF = 3.6;

const CATALOG = [
  { id: 'sofa', name: '소파', price: 120, emoji: '🛋️', w: 1.8, d: 0.85, h: 0.7, color: 0x6d4c41 },
  { id: 'plant', name: '화분', price: 45, emoji: '🪴', w: 0.4, d: 0.4, h: 0.6, color: 0x388e3c },
  { id: 'lamp', name: '스탠드', price: 60, emoji: '💡', w: 0.28, d: 0.28, h: 1.45, color: 0xffb300 },
  { id: 'table', name: '테이블', price: 90, emoji: '🪑', w: 1.15, d: 0.75, h: 0.48, color: 0x5d4037 },
  { id: 'tv', name: 'TV', price: 200, emoji: '📺', w: 1.25, d: 0.1, h: 0.72, color: 0x263238 },
  { id: 'rug', name: '러그', price: 75, emoji: '🟫', w: 2.1, d: 1.4, h: 0.04, color: 0x795548 },
  { id: 'clock', name: '시계', price: 55, emoji: '🕐', w: 0.45, d: 0.08, h: 0.55, color: 0x8d6e63 },
  { id: 'art', name: '그림', price: 85, emoji: '🖼️', w: 0.85, d: 0.06, h: 1.05, color: 0x5c6bc0 },
];

const catalogById = Object.fromEntries(CATALOG.map((c) => [c.id, c]));

const roomHost = document.getElementById('roomHost');
const coinDisplay = document.getElementById('coinDisplay');
const serverCoinDisplay = document.getElementById('serverCoinDisplay');
const coinHint = document.getElementById('coinHint');
const shopList = document.getElementById('shopList');
const invList = document.getElementById('invList');
const placeHint = document.getElementById('placeHint');
const btnRemoveSelected = document.getElementById('btnRemoveSelected');
const shopPanel = document.getElementById('shopPanel');
const invPanel = document.getElementById('invPanel');

const urlParams = new URLSearchParams(window.location.search);
const alpToken = urlParams.get('token');
const platformApi = window.__ALP_PLATFORM_API__ || '';

let isLoggedIn = false;
let serverCoins = 0;
let selectedPlaceId = null;
let selectedCatalogId = null;
let lastDragEndTime = 0;

const furnitureMap = new Map();
let dragTarget = null;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragOffset = new THREE.Vector3();
const planeHit = new THREE.Vector3();
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();

let scene, camera, renderer, controls;
let floorMesh;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function getInventory() {
  const inv = loadJson(LS.INV, {});
  return typeof inv === 'object' && inv !== null ? inv : {};
}

function setInventory(inv) {
  saveJson(LS.INV, inv);
}

function migrateLegacyPlaced(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const first = arr[0];
  if (first && typeof first.z === 'number') return arr;
  if (first && typeof first.x === 'number' && typeof first.y === 'number') {
    const scale = ROOM_HALF * 1.8;
    return arr.map((p) => ({
      id: p.id,
      catId: p.catId,
      x: Math.max(-ROOM_HALF, Math.min(ROOM_HALF, ((p.x / 100) - 0.5) * scale)),
      z: Math.max(-ROOM_HALF, Math.min(ROOM_HALF, ((0.5 - p.y / 100) * scale))),
      ry: typeof p.ry === 'number' ? p.ry : 0,
    }));
  }
  return [];
}

function getPlaced() {
  let arr = loadJson(LS.PLACED, []);
  if (!Array.isArray(arr) || arr.length === 0) {
    const legacy = loadJson(LS.PLACED_LEGACY, []);
    arr = migrateLegacyPlaced(legacy);
    if (arr.length) saveJson(LS.PLACED, arr);
  }
  return Array.isArray(arr) ? arr : [];
}

function setPlaced(arr) {
  saveJson(LS.PLACED, arr);
}

function getTotalSpent() {
  return Math.max(0, Number(localStorage.getItem(LS.SPENT)) || 0);
}

function addTotalSpent(n) {
  localStorage.setItem(LS.SPENT, String(getTotalSpent() + n));
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

function getDisplayBalance() {
  if (isLoggedIn) {
    return Math.max(0, serverCoins - getTotalSpent());
  }
  return getGuestWallet();
}

function trySpend(price) {
  if (price <= 0) return false;
  if (getDisplayBalance() < price) return false;
  if (isLoggedIn) {
    addTotalSpent(price);
  } else {
    setGuestWallet(getGuestWallet() - price);
  }
  return true;
}

function refreshCoinUi() {
  const bal = getDisplayBalance();
  coinDisplay.textContent = bal.toLocaleString();
  if (isLoggedIn) {
    serverCoinDisplay.textContent = serverCoins.toLocaleString();
    coinHint.textContent =
      '구매 금액은 로컬에 기록됩니다. 표시 잔액 = 서버 코인 − 누적 구매.';
  } else {
    serverCoinDisplay.textContent = '—';
    coinHint.textContent = '게스트: 코인은 이 브라우저에만 저장됩니다.';
  }
}

function fetchServerCoins() {
  if (!alpToken || !platformApi) {
    isLoggedIn = false;
    refreshCoinUi();
    return;
  }
  fetch(`${platformApi}/api/auth/me`, {
    headers: { Authorization: `Bearer ${alpToken}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.user && typeof data.user.coins === 'number') {
        isLoggedIn = true;
        serverCoins = data.user.coins;
      } else {
        isLoggedIn = false;
      }
      refreshCoinUi();
      renderShop();
    })
    .catch(() => {
      isLoggedIn = false;
      refreshCoinUi();
      renderShop();
    });
}

function makeWoodFloorTexture() {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
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
    ctx.strokeStyle = `rgba(62, 39, 35, ${0.08 + (i % 3) * 0.04})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let j = 0; j < 24; j += 1) {
    const y = (j / 24) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
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
        color: 0xfff8e1,
        emissive: 0xffe082,
        emissiveIntensity: 1.1,
        roughness: 0.2,
        metalness: 0,
      })
    );
    bulb.position.set(0, cat.h - 0.06, 0);
    g.add(bulb);
  }
  if (cat.id === 'plant') {
    const top = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0x2e7d32,
        roughness: 0.88,
        metalness: 0,
      })
    );
    top.position.set(0, cat.h + 0.12, 0);
    g.add(top);
  }
  return g;
}

function clampToRoom(x, z) {
  const m = ROOM_HALF - 0.2;
  return {
    x: Math.max(-m, Math.min(m, x)),
    z: Math.max(-m, Math.min(m, z)),
  };
}

function setGroupFromRecord(group, p, cat) {
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
  const placed = getPlaced();
  const ids = new Set(placed.map((p) => p.id));

  furnitureMap.forEach((group, id) => {
    if (!ids.has(id)) {
      scene.remove(group);
      furnitureMap.delete(id);
    }
  });

  placed.forEach((p) => {
    const cat = catalogById[p.catId];
    if (!cat) return;
    let group = furnitureMap.get(p.id);
    if (!group) {
      group = buildFurnitureGroup(cat);
      group.userData.placeId = p.id;
      group.userData.catId = p.catId;
      scene.add(group);
      furnitureMap.set(p.id, group);
    }
    setGroupFromRecord(group, p, cat);
  });

  if (selectedPlaceId && !ids.has(selectedPlaceId)) {
    selectedPlaceId = null;
  }
  highlightSelection();
}

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

function buyItem(catId) {
  const item = catalogById[catId];
  if (!item) return;
  if (!trySpend(item.price)) {
    alert('코인이 부족합니다.');
    return;
  }
  const inv = getInventory();
  inv[catId] = (inv[catId] || 0) + 1;
  setInventory(inv);
  refreshCoinUi();
  renderShop();
  renderInventory();
}

function renderInventory() {
  invList.innerHTML = '';
  const inv = getInventory();
  CATALOG.forEach((item) => {
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
  if (selectedCatalogId) {
    const it = catalogById[selectedCatalogId];
    placeHint.textContent = `「${it.name}」 배치 — 바닥을 클릭하세요. (시점 돌리기는 상단 버튼)`;
  } else {
    placeHint.textContent = '「내 가구」에서 가구를 선택하거나, 배치된 가구를 클릭해 선택하세요.';
  }
}

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

function placeAtWorld(x, z) {
  if (!selectedCatalogId) return;
  const inv = getInventory();
  if ((inv[selectedCatalogId] || 0) <= 0) return;
  inv[selectedCatalogId] -= 1;
  if (inv[selectedCatalogId] <= 0) delete inv[selectedCatalogId];
  setInventory(inv);
  const c = clampToRoom(x, z);
  const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const placed = getPlaced();
  placed.push({ id, catId: selectedCatalogId, x: c.x, z: c.z, ry: 0 });
  setPlaced(placed);
  selectedCatalogId = null;
  renderInventory();
  syncSceneFromData();
  updatePlaceHint();
  renderShop();
}

function saveDraggedPosition(placeId, x, z) {
  const placed = getPlaced();
  const idx = placed.findIndex((p) => p.id === placeId);
  if (idx < 0) return;
  const c = clampToRoom(x, z);
  placed[idx].x = c.x;
  placed[idx].z = c.z;
  setPlaced(placed);
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
  sun.shadow.camera.left = -8;
  sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8;
  sun.shadow.camera.bottom = -8;
  scene.add(sun);

  const floorTex = makeWoodFloorTexture();
  const floorGeo = new THREE.PlaneGeometry(ROOM_HALF * 2.2, ROOM_HALF * 2.2);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0.04,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  floorMesh.userData.isFloor = true;
  scene.add(floorMesh);

  const grid = new THREE.GridHelper(ROOM_HALF * 2.2, 16, 0xa89f97, 0xc4bbb3);
  const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMats.forEach((m) => {
    m.transparent = true;
    m.opacity = 0.32;
  });
  grid.position.y = 0.002;
  scene.add(grid);

  function resize() {
    const w = roomHost.clientWidth;
    const h = roomHost.clientHeight;
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
        dragTarget.position.x - planeHit.x,
        0,
        dragTarget.position.z - planeHit.z
      );
    }
    ev.preventDefault();
    return;
  }

  selectedPlaceId = null;
  highlightSelection();

  if (!selectedCatalogId) return;

  const floorHit = intersects.find((h) => h.object === floorMesh);
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

function onPointerUp(ev) {
  if (dragTarget && dragTarget.userData.moved) {
    saveDraggedPosition(dragTarget.userData.placeId, dragTarget.position.x, dragTarget.position.z);
    lastDragEndTime = performance.now();
  }
  if (dragTarget) {
    dragTarget.userData.moved = false;
  }
  dragTarget = null;
}

function animate() {
  requestAnimationFrame(animate);
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

btnRemoveSelected.addEventListener('click', () => {
  if (!selectedPlaceId) return;
  const placed = getPlaced().filter((p) => p.id !== selectedPlaceId);
  setPlaced(placed);
  selectedPlaceId = null;
  syncSceneFromData();
  updatePlaceHint();
});

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
    renderInventory();
    updatePlaceHint();
  }
});
roomHost.parentElement.insertBefore(btnOrbit, placeHint);

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    shopPanel.classList.toggle('hidden', id !== 'shop');
    invPanel.classList.toggle('hidden', id !== 'inv');
  });
});

initThree();
fetchServerCoins();
syncSceneFromData();
renderShop();
renderInventory();
updatePlaceHint();
animate();
