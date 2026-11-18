import { createModelPreview } from './assets/model-preview.js';

const catalogUrl = new URL('./models.json', import.meta.url);
const assetsUrl = new URL('./assets/', catalogUrl);
const grid = document.querySelector('#model-grid');
const categories = document.querySelector('#categories');
const catalogStatus = document.querySelector('#catalog-status');
const comparison = document.querySelector('#comparison');
const comparisonTitle = document.querySelector('#comparison-title');
const comparisonNote = document.querySelector('#comparison-note');
const comparisonMeta = document.querySelector('#comparison-meta');
const inputFrame = document.querySelector('#input-frame');
const preview = createModelPreview(document.querySelector('#gallery-preview'), { ar: true });
const formatFaces = new Intl.NumberFormat('zh-CN');

let models = [];
let category = null;
let selectedId = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function assetUrl(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  try {
    const url = new URL(path, catalogUrl);
    return url.origin === assetsUrl.origin && url.pathname.startsWith(assetsUrl.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function describe(model) {
  return Number.isFinite(model.faces) && model.faces > 0
    ? `${model.category} · ${formatFaces.format(model.faces)} 个三角面`
    : model.category;
}

function showInput(model) {
  const source = assetUrl(model.input);
  if (!source) {
    inputFrame.replaceChildren(element('p', 'viewer-message', '暂无输入照片。'));
    return;
  }
  const image = element('img');
  image.alt = `${model.name}的输入照片`;
  image.addEventListener('error', () => {
    if (inputFrame.contains(image)) {
      inputFrame.replaceChildren(element('p', 'viewer-message', '输入照片加载失败。'));
    }
  });
  image.src = source;
  inputFrame.replaceChildren(image);
}

function selectModel(model, url) {
  if (selectedId !== model.id) {
    selectedId = model.id;
    for (const card of grid.querySelectorAll('button[data-model-id]')) {
      card.setAttribute('aria-pressed', String(card.dataset.modelId === selectedId));
    }
    comparisonTitle.textContent = model.name;
    comparisonNote.textContent = model.note || '';
    comparisonMeta.textContent = describe(model);
    showInput(model);
    comparison.hidden = false;
    void preview.show({
      url,
      title: `${model.name}的 3D 模型`,
      poster: assetUrl(model.poster),
      filename: `${model.name}.glb`,
    });
  }
  comparison.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  comparisonTitle.focus({ preventScroll: true });
}

function renderCards() {
  const visible = models.filter((model) => category === null || model.category === category);
  if (selectedId !== null && !visible.some((model) => model.id === selectedId)) {
    selectedId = null;
    comparison.hidden = true;
    inputFrame.replaceChildren();
    preview.clear();
  }

  grid.replaceChildren(...visible.map((model) => {
    const url = assetUrl(model.glb);
    const thumbnail = assetUrl(model.poster) ?? assetUrl(model.input);
    const card = element(url ? 'button' : 'article', url ? 'model-card' : 'model-card is-placeholder');
    const visual = element('span', 'card-visual');
    const placeholder = element('span', 'card-placeholder');
    const mark = element('span', 'card-placeholder-symbol', '＋');
    mark.setAttribute('aria-hidden', 'true');
    placeholder.append(mark, element('span', '', url ? '暂无缩略图' : '待加入'));
    if (thumbnail) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        image.replaceWith(placeholder);
        visual.classList.add('no-thumbnail');
      });
      image.src = thumbnail;
      visual.append(image);
    } else {
      visual.classList.add('no-thumbnail');
      visual.append(placeholder);
    }
    visual.append(element('span', 'source-tag', model.source));
    const body = element('span', 'card-body');
    const caption = element('span');
    caption.append(element('span', 'card-title', model.name), element('span', 'model-meta', describe(model)));
    body.append(caption);
    if (url) {
      card.type = 'button';
      card.dataset.modelId = model.id;
      card.setAttribute('aria-pressed', String(model.id === selectedId));
      card.addEventListener('click', () => selectModel(model, url));
      body.append(element('span', 'card-action', '查看对比 ↗'));
    }
    card.append(visual, body);
    return card;
  }));

  catalogStatus.textContent = visible.length ? '' : '该类别暂无展品。';
  catalogStatus.hidden = visible.length > 0;
}

function renderFilters() {
  const values = [null, ...new Set(models.map((model) => model.category))];
  const buttons = values.map((value) => {
    const button = element('button', 'filter-chip', value ?? '全部');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(value === category));
    button.addEventListener('click', () => {
      if (category === value) return;
      category = value;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
      renderCards();
    });
    return button;
  });
  categories.replaceChildren(...buttons);
}

try {
  const response = await fetch(catalogUrl);
  if (!response.ok) throw new Error('Catalog unavailable');
  models = await response.json();
  if (!Array.isArray(models)) throw new Error('Invalid catalog');
  renderFilters();
  renderCards();
} catch {
  catalogStatus.hidden = false;
  catalogStatus.textContent = '模型清单读取失败。请检查展厅目录中的 models.json。';
  catalogStatus.setAttribute('role', 'alert');
}
