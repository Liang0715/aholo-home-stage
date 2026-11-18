import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneScene } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from './decoders/meshopt_decoder.module.js';

const maxItems = 6;
const edgeTolerance = 0.00001;
const hashPrefix = '#layout=';
const catalogUrl = new URL('../models.json', import.meta.url);
const assetRoot = new URL('./', import.meta.url);
const dimensionsFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4, useGrouping: false });

const viewport = document.querySelector('#layout-viewport');
const canvas = document.querySelector('#layout-canvas');
const viewportMessage = document.querySelector('#layout-viewport-message');
const catalog = document.querySelector('#layout-catalog');
const catalogStatus = document.querySelector('#layout-catalog-status');
const count = document.querySelector('#layout-count');
const itemsList = document.querySelector('#layout-items');
const emptyList = document.querySelector('#layout-empty-list');
const selection = document.querySelector('#layout-selection');
const rotation = document.querySelector('#layout-rotation');
const angle = document.querySelector('#layout-angle');
const heightControl = document.querySelector('#layout-height');
const heightValue = document.querySelector('#layout-height-value');
const placeTableButton = document.querySelector('#layout-place-table');
const removeButton = document.querySelector('#layout-remove');
const stageSizeControl = document.querySelector('#layout-stage-size');
const stageSizeValue = document.querySelector('#layout-size-value');
const shareButton = document.querySelector('#layout-share');
const shareField = document.querySelector('#layout-share-url');
const warningsList = document.querySelector('#layout-warnings');
const feedback = document.querySelector('#layout-feedback');

const scene = new THREE.Scene();
const stageGroup = new THREE.Group();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 60);
const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xa3efd7);
const overlapMaterial = new THREE.MeshStandardMaterial({
  color: 0xe3404a,
  emissive: 0x441014,
  roughness: 0.72,
  side: THREE.DoubleSide,
});
const raycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointer = new THREE.Vector2();
const dragPoint = new THREE.Vector3();
const modelById = new Map();
const assetLoads = new Map();
const itemByGroup = new Map();
const placed = [];
const minStageSize = Number(stageSizeControl.min);
const maxStageSize = Number(stageSizeControl.max);
const maxHeight = Number(heightControl.max);

let renderer;
let controls;
let renderFrame;
let selected;
let drag;
let nextItem = 1;
let warningText = '';
let catalogReady = false;
let graphicsReady = false;
let stageSize = Number(stageSizeControl.defaultValue);

function localAsset(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, catalogUrl);
    return url.origin === assetRoot.origin && url.pathname.startsWith(assetRoot.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

const manager = new THREE.LoadingManager();
manager.setURLModifier((value) => {
  const url = new URL(value, catalogUrl);
  if (url.protocol === 'blob:' || url.protocol === 'data:') return value;
  const asset = localAsset(value);
  if (!asset) throw new Error('Model contains a non-local resource');
  return asset;
});
const loader = new GLTFLoader(manager);
loader.setMeshoptDecoder(MeshoptDecoder);

function createText(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function showFeedback(message = '', tone = 'normal') {
  feedback.textContent = message;
  feedback.dataset.tone = tone;
  feedback.hidden = !message;
  shareField.hidden = true;
}

function requestRender() {
  if (!graphicsReady || renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = undefined;
    if (graphicsReady) renderer.render(scene, camera);
  });
}

function nearestTable(item) {
  if (!item?.group || item.model.id === 'table') return null;
  let nearest = null;
  let distance = Infinity;
  for (const table of placed) {
    if (!table.group || table.model.id !== 'table' || table.bounds.max.y > maxHeight) continue;
    const distanceToTable = Math.hypot(table.x - item.x, table.z - item.z);
    if (distanceToTable < distance) {
      nearest = table;
      distance = distanceToTable;
    }
  }
  return nearest;
}

function updateControls() {
  count.textContent = `${placed.length} / ${maxItems}`;
  emptyList.hidden = placed.length > 0;
  for (const model of modelById.values()) {
    model.button.disabled = !graphicsReady || !model.url || placed.length >= maxItems;
  }
  for (const item of placed) {
    item.button.setAttribute('aria-pressed', String(item === selected));
  }
  selection.hidden = !selected;
  heightControl.disabled = rotation.disabled = !selected?.group;
  placeTableButton.hidden = !nearestTable(selected);
  if (selected) {
    rotation.value = String(selected.rotation);
    angle.value = `${selected.rotation}°`;
    heightControl.value = String(selected.y);
    heightValue.value = dimensionsFormat.format(selected.y);
  }
  shareButton.disabled = !graphicsReady || !placed.length || placed.some((item) => !item.group);
  if (graphicsReady) {
    viewportMessage.hidden = placed.some((item) => item.group);
    viewportMessage.textContent = placed.length ? '正在加载展品…' : '从展品列表添加一个模型。';
  }
  selectionBox.visible = Boolean(selected?.group);
  if (selected?.group) selectionBox.box = selected.bounds;
  requestRender();
}

function updateBounds(item) {
  item.group.position.set(item.x, item.y, item.z);
  item.group.rotation.y = THREE.MathUtils.degToRad(item.rotation);
  item.group.updateMatrixWorld(true);
  item.bounds.copy(item.localBounds).applyMatrix4(item.group.matrixWorld);
}

function boxesOverlap(a, b) {
  const width = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const height = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const depth = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return width > edgeTolerance && height > edgeTolerance && depth > edgeTolerance;
}

function findOpenPosition(bounds) {
  const halfStage = stageSize / 2;
  const { x: width, z: depth } = bounds.getSize(new THREE.Vector3());
  const margin = Math.max(0, Math.min(0.025, (stageSize - width) / 2, (stageSize - depth) / 2));
  const minX = -halfStage - bounds.min.x + margin;
  const maxX = halfStage - bounds.max.x - margin;
  const minZ = -halfStage - bounds.min.z + margin;
  const maxZ = halfStage - bounds.max.z - margin;
  if (minX > maxX || minZ > maxZ) return [0, 0];

  const occupied = placed.filter((item) => item.group).map((item) => item.bounds);
  const candidate = new THREE.Box3();
  const offset = new THREE.Vector3();
  const available = (x, z) => {
    candidate.copy(bounds).translate(offset.set(x, 0, z)).expandByScalar(0.02);
    return occupied.every((other) => !boxesOverlap(candidate, other));
  };
  if (available(0, 0)) return [0, 0];

  const intervals = 8;
  for (let column = 0; column <= intervals; column++) {
    const x = THREE.MathUtils.lerp(minX, maxX, column / intervals);
    for (let row = 0; row <= intervals; row++) {
      const z = THREE.MathUtils.lerp(minZ, maxZ, row / intervals);
      if (available(x, z)) return [x, z];
    }
  }
  return [0, 0];
}

function checkLayout() {
  const halfStage = stageSize / 2;
  const ready = placed.filter((item) => item.group);
  const messages = [];
  const overlapping = new Set();
  const outside = new Set();
  for (const [index, first] of ready.entries()) {
    const { min, max } = first.bounds;
    if (min.x < -halfStage - edgeTolerance || min.z < -halfStage - edgeTolerance
        || max.x > halfStage + edgeTolerance || max.z > halfStage + edgeTolerance) {
      outside.add(first);
      messages.push(`${first.name} 超出地面边界`);
    }
    for (const second of ready.slice(index + 1)) {
      if (boxesOverlap(first.bounds, second.bounds)) {
        overlapping.add(first);
        overlapping.add(second);
        messages.push(`${first.name} 与 ${second.name} 重叠`);
      }
    }
  }
  for (const item of ready) {
    const overlap = overlapping.has(item);
    if (item.overlap !== overlap) {
      for (const { mesh, material } of item.materials) mesh.material = overlap ? overlapMaterial : material;
      item.overlap = overlap;
    }
    item.button.dataset.warning = String(overlap || outside.has(item));
  }
  const nextWarnings = messages.join('\n');
  if (nextWarnings !== warningText) {
    warningText = nextWarnings;
    warningsList.replaceChildren(...messages.map((message) => createText('li', '', message)));
    warningsList.hidden = !messages.length;
  }
  requestRender();
}

function selectItem(item) {
  selected = item;
  updateControls();
}

function describeSize(size) {
  return `长 ${dimensionsFormat.format(size.x)} × 宽 ${dimensionsFormat.format(size.z)} × 高 ${dimensionsFormat.format(size.y)}`;
}

function updateLoadProgress(modelId, event) {
  const percent = event.lengthComputable && event.total > 0
    ? Math.min(100, Math.floor(100 * event.loaded / event.total))
    : null;
  for (const item of placed) {
    if (item.model.id !== modelId || item.group) continue;
    if (percent === null) {
      item.progress.removeAttribute('value');
      item.detail.textContent = `已读取 ${Math.ceil(event.loaded / 1024)} KB`;
    } else {
      item.progress.value = percent;
      item.detail.textContent = `正在加载 ${percent}%`;
    }
  }
}

function loadAsset(model) {
  if (!assetLoads.has(model.id)) {
    const pending = new Promise((resolve, reject) => {
      loader.load(model.url, resolve, (event) => updateLoadProgress(model.id, event), reject);
    }).then((gltf) => {
      const original = new THREE.Box3().setFromObject(gltf.scene, true);
      const size = original.getSize(new THREE.Vector3());
      if (original.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite) || size.lengthSq() === 0) {
        throw new Error('Model has no usable bounds');
      }
      const base = original.getCenter(new THREE.Vector3());
      base.y = original.min.y;
      return { scene: gltf.scene, size, base, bounds: original.translate(base.clone().negate()) };
    }).catch((error) => {
      assetLoads.delete(model.id);
      throw error;
    });
    assetLoads.set(model.id, pending);
  }
  return assetLoads.get(model.id);
}

function stopDrag() {
  if (!drag) return;
  const { pointerId } = drag;
  drag = undefined;
  controls.enabled = true;
  canvas.classList.remove('is-dragging');
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}

function removeItem(item, refresh = true) {
  const index = placed.indexOf(item);
  if (index < 0) return;
  if (drag?.item === item) stopDrag();
  placed.splice(index, 1);
  if (item.group) {
    scene.remove(item.group);
    itemByGroup.delete(item.group);
  }
  item.row.remove();
  if (selected === item) selected = placed[Math.min(index, placed.length - 1)];
  if (refresh) {
    updateControls();
    checkLayout();
  }
}

async function addItem(model, transform) {
  if (!graphicsReady || !model.url || placed.length >= maxItems) return;
  const item = {
    model,
    name: `${model.name} ${nextItem++}`,
    x: transform?.x ?? 0,
    y: transform?.y ?? 0,
    z: transform?.z ?? 0,
    rotation: transform?.rotation ?? 0,
    bounds: new THREE.Box3(),
    overlap: false,
  };
  item.row = document.createElement('li');
  item.button = document.createElement('button');
  item.button.type = 'button';
  item.button.className = 'layout-item-button';
  item.button.dataset.layoutItem = model.id;
  item.detail = createText('span', 'layout-item-detail', '正在加载模型…');
  item.progress = document.createElement('progress');
  item.progress.max = 100;
  item.progress.setAttribute('aria-label', `${item.name}加载进度`);
  const text = document.createElement('span');
  text.className = 'layout-item-text';
  text.append(createText('span', 'layout-item-name', item.name), item.detail, item.progress);
  item.button.append(text);
  item.button.addEventListener('click', () => selectItem(item));
  item.row.append(item.button);
  itemsList.append(item.row);
  placed.push(item);
  selectItem(item);

  try {
    const asset = await loadAsset(model);
    if (!placed.includes(item)) return;
    if (!transform) [item.x, item.z] = findOpenPosition(asset.bounds);
    const content = cloneScene(asset.scene);
    const offset = new THREE.Group();
    offset.position.copy(asset.base).negate();
    offset.add(content);
    item.group = new THREE.Group();
    item.group.add(offset);
    item.localBounds = asset.bounds;
    item.materials = [];
    content.traverse((object) => {
      if (object.isMesh) item.materials.push({ mesh: object, material: object.material });
    });
    scene.add(item.group);
    itemByGroup.set(item.group, item);
    item.detail.textContent = describeSize(asset.size);
    item.progress.remove();
    updateBounds(item);
    updateControls();
    checkLayout();
  } catch {
    if (!placed.includes(item)) return;
    removeItem(item);
    showFeedback(`${item.name} 加载失败，请检查展品的 GLB 文件是否可打开。`, 'error');
  }
}

function renderCatalog() {
  catalog.classList.add('layout-catalog-list');
  for (const model of modelById.values()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layout-model-button';
    button.dataset.modelId = model.id;
    model.button = button;
    const thumbnail = localAsset(model.poster) ?? localAsset(model.input);
    if (thumbnail) {
      const image = document.createElement('img');
      image.className = 'layout-model-thumbnail';
      image.alt = '';
      image.src = thumbnail;
      image.addEventListener('error', () => { image.hidden = true; });
      button.append(image);
    }
    const label = createText('span', 'layout-model-name', model.name);
    label.append(createText('span', 'layout-model-detail', model.category || '展品'));
    button.append(label, createText('span', 'layout-add-label', model.url ? '＋ 添加' : '待补充模型'));
    button.addEventListener('click', () => {
      showFeedback();
      void addItem(model);
    });
    catalog.append(button);
  }
  catalogStatus.hidden = modelById.size > 0;
  catalogStatus.textContent = '模型清单里还没有展品。';
  updateControls();
}

function restoreLayout() {
  if (!catalogReady || !graphicsReady || !location.hash.startsWith(hashPrefix)) return;

  let saved;
  try {
    const text = location.hash.slice(hashPrefix.length);
    if (text.length > 8192) throw new Error('Layout too large');
    saved = JSON.parse(decodeURIComponent(text));
    // 旧链接只保存物件，展台为 1 × 1。
    if (Array.isArray(saved)) saved = { stageSize: 1, items: saved };
    if (!Array.isArray(saved?.items) || !Number.isFinite(saved.stageSize)
        || saved.stageSize < minStageSize || saved.stageSize > maxStageSize) {
      throw new Error('Invalid layout');
    }
  } catch {
    showFeedback('无法读取分享链接中的布局。', 'error');
    return;
  }

  showFeedback();
  for (const item of [...placed]) removeItem(item, false);
  nextItem = 1;
  updateControls();
  setStageSize(saved.stageSize);

  let skipped = saved.items.length > maxItems;
  for (const entry of saved.items.slice(0, maxItems)) {
    const model = modelById.get(entry?.id);
    const y = entry?.y ?? 0;
    if (!model?.url || !Number.isFinite(entry.x) || !Number.isFinite(entry.z)
        || Math.abs(entry.x) > maxStageSize || Math.abs(entry.z) > maxStageSize
        || !Number.isFinite(y) || y < 0 || y > maxHeight
        || !Number.isInteger(entry.rotation) || entry.rotation < 0 || entry.rotation > 359) {
      skipped = true;
      continue;
    }
    void addItem(model, entry);
  }
  if (skipped) showFeedback('分享链接中有找不到的展品或无效位置。已还原可用摆放。', 'error');
}

function setRay(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height);
  raycaster.setFromCamera(pointer, camera);
}

function startDrag(event) {
  if (!graphicsReady) return;
  if (drag) {
    event.stopImmediatePropagation();
    return;
  }
  if (!event.isPrimary || event.button !== 0) return;
  setRay(event);
  const hit = raycaster.intersectObjects([...itemByGroup.keys()], true)[0];
  let target = hit?.object;
  while (target && !itemByGroup.has(target)) target = target.parent;
  if (!target) return;

  const item = itemByGroup.get(target);
  dragPlane.constant = -item.y;
  if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;
  selectItem(item);
  drag = {
    item,
    pointerId: event.pointerId,
    offsetX: dragPoint.x - item.x,
    offsetZ: dragPoint.z - item.z,
  };
  event.preventDefault();
  event.stopImmediatePropagation();
  controls.enabled = false;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
}

function moveDrag(event) {
  if (drag?.pointerId !== event.pointerId) return;
  event.stopImmediatePropagation();
  setRay(event);
  if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;

  const { item, offsetX, offsetZ } = drag;
  // 留出地面之外的移动范围，便于查看越界提示并把物件拖回。
  item.x = THREE.MathUtils.clamp(dragPoint.x - offsetX, -stageSize, stageSize);
  item.z = THREE.MathUtils.clamp(dragPoint.z - offsetZ, -stageSize, stageSize);
  showFeedback();
  updateBounds(item);
  checkLayout();
}

function endDrag(event) {
  if (drag?.pointerId !== event.pointerId) return;
  event.stopImmediatePropagation();
  stopDrag();
}

function fitCamera() {
  const { clientWidth: width, clientHeight: height } = viewport;
  if (!width || !height) return;
  const aspect = width / height;
  const span = Math.max(1.4, 1.6 / aspect) * stageSize;
  camera.left = -(span * aspect) / 2;
  camera.right = -camera.left;
  camera.top = span / 2;
  camera.bottom = -camera.top;
  camera.updateProjectionMatrix();
  requestRender();
}

function setStageSize(size) {
  stageSizeControl.value = String(size);
  stageSize = stageSizeControl.valueAsNumber;
  stageSizeValue.value = `${stageSize} × ${stageSize}（模型单位）`;
  stageGroup.scale.set(stageSize, 1, stageSize);
  stopDrag();
  if (controls) {
    const targetHeight = stageSize * 0.07;
    camera.position.y += targetHeight - controls.target.y;
    controls.target.y = targetHeight;
    controls.update();
    fitCamera();
  }
  checkLayout();
}

function initializeScene() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
  scene.background = new THREE.Color(0x152429);
  camera.position.set(1, 0.935, 1.12).normalize().multiplyScalar(14);
  controls = new OrbitControls(camera, canvas);
  controls.minPolarAngle = 0.08;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.enablePan = false;
  controls.minZoom = 0.52;
  controls.maxZoom = 6;
  controls.update();
  controls.addEventListener('change', requestRender);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x20363b, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  const grid = new THREE.GridHelper(1, 10, 0x659c93, 0x4a666b);
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, 0.001, z))),
    new THREE.LineBasicMaterial({ color: 0x79bdb2 }),
  );
  const light = new THREE.DirectionalLight(0xfff8ec, 2.15);
  light.position.set(0.6, 1.4, 1);
  selectionBox.visible = false;
  stageGroup.add(ground, grid, border);
  scene.add(stageGroup, selectionBox, new THREE.HemisphereLight(0xe7fbff, 0x758087, 1.8), light);

  graphicsReady = true;
  setStageSize(stageSize);
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = viewport;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    fitCamera();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  canvas.addEventListener('pointerdown', startDrag, true);
  canvas.addEventListener('pointermove', moveDrag, true);
  canvas.addEventListener('pointerup', endDrag, true);
  canvas.addEventListener('pointercancel', endDrag, true);
  canvas.addEventListener('lostpointercapture', endDrag, true);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    stopDrag();
    graphicsReady = false;
    viewportMessage.textContent = '3D 画面暂时中断，请等候恢复或刷新页面。';
    viewportMessage.hidden = false;
    updateControls();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    graphicsReady = true;
    updateControls();
  });
}

stageSizeControl.addEventListener('input', () => {
  showFeedback();
  setStageSize(stageSizeControl.valueAsNumber);
});

rotation.addEventListener('input', () => {
  if (!selected?.group) return;
  selected.rotation = Number(rotation.value);
  angle.value = `${selected.rotation}°`;
  showFeedback();
  updateBounds(selected);
  checkLayout();
});

heightControl.addEventListener('input', () => {
  if (!selected?.group) return;
  stopDrag();
  selected.y = heightControl.valueAsNumber;
  heightValue.value = dimensionsFormat.format(selected.y);
  showFeedback();
  updateBounds(selected);
  checkLayout();
});

placeTableButton.addEventListener('click', () => {
  const table = nearestTable(selected);
  if (!table) return;
  stopDrag();
  selected.x = table.x;
  selected.y = table.bounds.max.y;
  selected.z = table.z;
  showFeedback();
  updateBounds(selected);
  updateControls();
  checkLayout();
});

removeButton.addEventListener('click', () => {
  if (!selected) return;
  showFeedback();
  removeItem(selected);
  (selected?.button ?? catalog.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
});

shareButton.addEventListener('click', async () => {
  const items = placed.map(({ model, x, y, z, rotation }) => ({ id: model.id, x, y, z, rotation }));
  const link = new URL(location.href);
  link.hash = hashPrefix + encodeURIComponent(JSON.stringify({ stageSize, items }));
  history.replaceState(history.state, '', link.href);
  try {
    await navigator.clipboard.writeText(link.href);
    showFeedback('已复制分享链接。');
  } catch {
    showFeedback('已生成链接，可选中后手动复制。');
    shareField.value = link.href;
    shareField.hidden = false;
    shareField.focus();
    shareField.select();
  }
});

window.addEventListener('hashchange', restoreLayout);

try {
  initializeScene();
} catch {
  graphicsReady = false;
  viewportMessage.textContent = '当前浏览器无法打开 3D 展台，请使用支持 WebGL 的浏览器。';
}

try {
  const response = await fetch(catalogUrl);
  if (!response.ok) throw new Error('Catalog unavailable');
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid catalog');
  for (const model of data) {
    if (typeof model?.id === 'string' && model.id.trim() && typeof model.name === 'string'
        && !modelById.has(model.id)) {
      modelById.set(model.id, { ...model, url: localAsset(model.glb) });
    }
  }
  renderCatalog();
  catalogReady = true;
  restoreLayout();
} catch {
  catalogStatus.hidden = false;
  catalogStatus.textContent = '展品清单读取失败，请检查 models.json 后刷新。';
}
