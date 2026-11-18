import { createModelPreview } from './assets/model-preview.js';

const maxImageBytes = 5 * 1024 * 1024;
const waitLimit = 15 * 60_000;
const statuses = ['排队中', '生成中', '等待结果', '完成', '生成失败', '派发失败', '已取消'];
const taskStorageKey = 'lux3d-current-task';
const codeStorageKey = 'lux3d-tab-access-code';
const emptyPreview = '生成完成后，可在这里预览和下载模型。';

const form = document.querySelector('#generate-form');
const imageInput = document.querySelector('#image');
const uploadPhoto = document.querySelector('#upload-photo');
const uploadPlaceholder = document.querySelector('#upload-placeholder');
const imageName = document.querySelector('#image-name');
const codeInput = document.querySelector('#access-code');
const submitButton = document.querySelector('#submit-task');
const resumeButton = document.querySelector('#resume-task');
const taskReference = document.querySelector('#task-reference');
const clock = document.querySelector('#elapsed-time');
const taskStatus = document.querySelector('#task-status');
const taskError = document.querySelector('#task-error');
const errorCode = document.querySelector('#task-error-code');
const errorMessage = document.querySelector('#task-error-message');
const preview = createModelPreview(document.querySelector('#generate-preview'), { emptyMessage: emptyPreview });

class RequestFailure extends Error {
  constructor(c, m, { status, transient = false } = {}) {
    super(m);
    this.c = c;
    this.status = status;
    this.transient = transient;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validTaskId = (value) => /^[1-9]\d{0,18}$/.test(String(value));

function restoreTask() {
  try {
    const saved = JSON.parse(localStorage.getItem(taskStorageKey));
    return validTaskId(saved?.taskId) && Number.isFinite(saved.startedAt) ? saved : null;
  } catch {
    return null;
  }
}

function readCode() {
  try {
    return sessionStorage.getItem(codeStorageKey) || '';
  } catch {
    return '';
  }
}

function rememberCode(code) {
  try {
    if (code) sessionStorage.setItem(codeStorageKey, code);
    else sessionStorage.removeItem(codeStorageKey);
  } catch {
    // 存储不可用时，本次页面仍可以查询任务。
  }
}

let task = restoreTask();
let busy = false;
let mayResume = Boolean(task);
let inputUrl;
let modelUrl;

function showTask() {
  taskReference.textContent = task ? `任务 ${task.taskId}` : '';
  taskReference.hidden = !task;
}

function showElapsed(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  clock.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  clock.dateTime = `PT${seconds}S`;
}

function showStatus(text, tone = 'neutral') {
  taskStatus.textContent = text;
  taskStatus.dataset.tone = tone;
}

function showError(error) {
  const failure = error instanceof RequestFailure
    ? error
    : new RequestFailure('REQUEST_FAILED', '处理请求时发生错误。');
  showStatus(
    failure.c === 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED'
      ? 'Aholo 并发任务已满，请等待已有任务完成。'
      : (failure.status === 401 ? '请检查访问口令' : '失败'),
    'error',
  );
  errorCode.textContent = failure.c;
  errorMessage.textContent = failure.message;
  taskError.hidden = false;
  if (failure.status === 401) rememberCode('');
}

function updateControls() {
  imageInput.disabled = busy;
  codeInput.disabled = busy;
  submitButton.disabled = busy;
  resumeButton.hidden = busy || !mayResume;
}

async function readError(response) {
  const payload = await response.json().catch(() => null);
  return new RequestFailure(
    typeof payload?.c === 'string' ? payload.c : `HTTP_${response.status}`,
    typeof payload?.m === 'string' ? payload.m : '请求出错。请确认上传页通过本地后端打开。',
    { status: response.status, transient: response.status >= 500 },
  );
}

async function request(path, code, { body, timeout = 15_000 } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      body,
      headers: { 'X-Access-Code': encodeURIComponent(code) },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new RequestFailure('CONNECTION_FAILED', '连接本地后端失败或超时。', { transient: true });
  }
  if (!response.ok) throw await readError(response);
  return response;
}

async function requestJson(path, code, options) {
  const response = await request(path, code, options);
  try {
    return await response.json();
  } catch {
    throw new RequestFailure('INVALID_RESPONSE', '后端返回了无法识别的响应。请确认上传页通过本地后端打开。');
  }
}

function clearModel() {
  preview.clear();
  if (modelUrl) URL.revokeObjectURL(modelUrl);
  modelUrl = undefined;
}

async function showModel(path, code, id) {
  let url;
  try { url = new URL(path, location.href); } catch { /* handled below */ }
  if (!url || url.origin !== location.origin || url.pathname !== `/generated/${id}.glb`) {
    throw new RequestFailure('INVALID_MODEL_URL', '后端返回的本地模型地址无效。');
  }
  showStatus('正在读取 GLB', 'active');
  const response = await request(url, code, { timeout: 120_000 });
  const blob = await response.blob();
  if (!blob.size) throw new RequestFailure('EMPTY_GLB', '本地 GLB 文件为空。');
  clearModel();
  modelUrl = URL.createObjectURL(blob);
  void preview.show({ url: modelUrl, title: '生成的 3D 模型', filename: `${id}.glb` });
}

async function followJob(job, code) {
  const deadline = job.startedAt + waitLimit;
  const taskPath = `/api/task/${encodeURIComponent(job.taskId)}`;
  let firstQuery = true;
  let retries = 0;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 && !firstQuery) {
      throw new RequestFailure('TASK_TIMEOUT', '已等待 15 分钟。可继续查询此任务，查看是否已有结果。');
    }
    firstQuery = false;
    let data;
    try {
      data = await requestJson(taskPath, code, { timeout: remaining > 0 ? Math.min(15_000, remaining) : 15_000 });
    } catch (error) {
      if (!error.transient || retries >= 3 || Date.now() >= deadline) throw error;
      retries += 1;
      showStatus('暂时无法查询，正在重试', 'active');
      await sleep(Math.min(2_000, deadline - Date.now()));
      continue;
    }
    retries = 0;
    if (!Number.isInteger(data?.status) || data.status < 0 || data.status >= statuses.length) {
      throw new RequestFailure('INVALID_TASK_STATUS', '后端返回了无法识别的任务状态。');
    }
    if (data.status >= 4) {
      mayResume = false;
      showError(new RequestFailure(data.c ?? String(data.status), data.m ?? statuses[data.status]));
      return data.elapsedMs;
    }
    if (data.status === 3) {
      await showModel(data.glbUrl, code, job.taskId);
      mayResume = false;
      showStatus('完成', 'complete');
      return data.elapsedMs;
    }
    showStatus(data.description || statuses[data.status], 'active');
    await sleep(Math.max(0, Math.min(12_000, deadline - Date.now())));
  }
}

async function run(startedAt, work) {
  if (busy) return;
  busy = true;
  updateControls();
  taskError.hidden = true;
  const tick = () => showElapsed(Math.min(waitLimit, Date.now() - startedAt));
  tick();
  const timer = setInterval(tick, 1000);
  let elapsed;
  try {
    elapsed = await work();
  } catch (error) {
    showError(error);
  } finally {
    clearInterval(timer);
    if (Number.isFinite(elapsed)) showElapsed(elapsed);
    else tick();
    busy = false;
    updateControls();
  }
}

function resume(code) {
  if (!task) return;
  if (!code) {
    showError(new RequestFailure('ACCESS_CODE_REQUIRED', '请输入访问口令。'));
    codeInput.focus();
    return;
  }
  rememberCode(code);
  showTask();
  showStatus('正在查询已有任务', 'active');
  void run(task.startedAt, () => followJob(task, code));
}

imageInput.addEventListener('change', () => {
  if (inputUrl) URL.revokeObjectURL(inputUrl);
  const image = imageInput.files[0];
  inputUrl = image ? URL.createObjectURL(image) : undefined;
  if (inputUrl) uploadPhoto.src = inputUrl;
  else uploadPhoto.removeAttribute('src');
  uploadPhoto.hidden = !image;
  uploadPlaceholder.hidden = Boolean(image);
  imageName.hidden = !image;
  imageName.textContent = image?.name ?? '';
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const code = codeInput.value.trim();
  const image = imageInput.files[0];
  if (!code) {
    showError(new RequestFailure('ACCESS_CODE_REQUIRED', '请输入访问口令。'));
    codeInput.focus();
    return;
  }
  if (!image) { showError(new RequestFailure('IMAGE_REQUIRED', '请先选择一张 JPG 或 PNG 照片。')); return; }
  const mime = image.type || (/\.png$/i.test(image.name) ? 'image/png'
    : /\.jpe?g$/i.test(image.name) ? 'image/jpeg' : '');
  if (!['image/jpeg', 'image/png'].includes(mime)) {
    showError(new RequestFailure('INVALID_IMAGE_TYPE', '请选择 JPG 或 PNG 照片。'));
    return;
  }
  if (image.size === 0 || image.size > maxImageBytes) {
    showError(new RequestFailure('INVALID_IMAGE_SIZE', '照片应大于 0 字节且不超过 5 MB。'));
    return;
  }

  const body = new FormData();
  body.append('image', image.type ? image : new Blob([image], { type: mime }), image.name);
  const startedAt = Date.now();
  clearModel();
  taskReference.hidden = true;
  rememberCode(code);
  showStatus('正在上传照片', 'active');
  void run(startedAt, async () => {
    const data = await requestJson('/api/generate', code, { body, timeout: 150_000 });
    if (!validTaskId(data?.taskId)) {
      throw new RequestFailure('INVALID_TASK_ID', '后端未返回可查询的任务 ID。');
    }
    task = { taskId: data.taskId, startedAt };
    mayResume = true;
    showTask();
    try {
      localStorage.setItem(taskStorageKey, JSON.stringify(task));
    } catch {
      // 存储不可用时，继续本次页面上的任务查询。
    }
    showStatus('排队中', 'active');
    return followJob(task, code);
  });
});

resumeButton.addEventListener('click', () => resume(codeInput.value.trim()));
codeInput.value = readCode();
showTask();
updateControls();
if (task && codeInput.value) resume(codeInput.value);
else if (task) {
  showElapsed(Math.min(waitLimit, Date.now() - task.startedAt));
  showStatus('输入口令可继续查询');
}
