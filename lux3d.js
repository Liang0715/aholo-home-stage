const { randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { appendFile, open, rename, rm } = require('node:fs/promises');
const { request } = require('node:https');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const faceCount = 100_000;
const maxImageBytes = 5 * 1024 * 1024;
const pollTimeoutMs = 15 * 60_000;
const requestTimeoutMs = 20_000;
const allowedBases = new Set(['https://api.aholo.cn', 'https://api.aholo3d.cn']);
const maxTaskId = 9_223_372_036_854_775_807n;

class RequestError extends Error {
  constructor(status, c, m) {
    super(m);
    this.status = status;
    this.c = c;
  }
}

function readLuxConfig(env = process.env) {
  const apiKey = env.AHOLO_API_KEY?.trim();
  const base = env.AHOLO_BASE?.trim().replace(/\/+$/, '');
  const version = env.LUX_VERSION?.trim() || 'G1';
  if (!apiKey) throw new Error('缺少环境变量 AHOLO_API_KEY。');
  if (!allowedBases.has(base)) throw new Error('请将 AHOLO_BASE 设为已验证网关的 HTTPS 地址。');
  if (!['G1', 'G1-Turbo'].includes(version)) throw new Error('LUX_VERSION 只能设为 G1 或 G1-Turbo。');
  return { apiKey, base, version };
}

function makeRedactor(...secrets) {
  const forms = new Set();
  for (const value of secrets.filter(Boolean)) {
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(encodeURIComponent(value));
  }
  return (text) => {
    let result = String(text);
    for (const value of forms) result = result.replaceAll(value, '[已隐藏]');
    return result;
  };
}

function toTaskId(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value);
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > maxTaskId) return null;
  return id;
}

function jsonTaskId(id) {
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : id;
}

function httpUrl(value) {
  if (typeof value !== 'string') return null;
  const url = URL.parse(value);
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
    return url;
  }
  return null;
}

function readEnvelope(text) {
  return JSON.parse(text, (field, value, context) => {
    // JSON 中的长整数任务 ID 必须保留原值，避免 Number 舍入到另一个任务。
    if ((field === 'd' || field === 'taskId') && typeof value === 'number'
        && !Number.isSafeInteger(value) && toTaskId(context?.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}

function providerError(httpStatus, envelope, redact, defaultCode, defaultMessage) {
  const hasBusinessError = typeof envelope?.c === 'string' && envelope.c !== '0';
  const c = hasBusinessError ? envelope.c : defaultCode;
  const m = hasBusinessError ? (envelope.m ?? '') : defaultMessage;
  const status = httpStatus === 429 || c === 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED' ? 429 : 502;
  return new RequestError(status, redact(c), redact(m));
}

async function createLuxClient(config, { onResponse, redact = makeRedactor(config.apiKey) } = {}) {
  const { createAssetClient } = await import('@manycore/aholo-sdk-asset');
  const asset = createAssetClient({ region: 'cn' });

  async function call(path, label, { body, timeoutMs = requestTimeoutMs } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: config.apiKey, 'Content-Type': 'application/json' };
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const signal = AbortSignal.timeout(timeoutMs);

    let response;
    try {
      response = await new Promise((resolve, reject) => {
        // 原生 HTTPS 只发送一次请求，创建任务时不会自动跟随跳转或重试。
        const req = request(new URL(path, config.base), {
          method: payload === undefined ? 'GET' : 'POST',
          headers,
          signal,
        }, (res) => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.once('error', reject);
          res.once('end', () => resolve({ status: res.statusCode, text }));
        });
        req.once('error', reject);
        req.end(payload);
      });
    } catch {
      if (signal.aborted) throw new RequestError(504, 'AHOLO_TIMEOUT', `${label}请求超时。`);
      throw new RequestError(502, 'AHOLO_NETWORK_ERROR', `${label}连接失败或响应中断。`);
    }

    onResponse?.(label, response.status, redact(response.text));
    let envelope;
    try {
      envelope = readEnvelope(response.text);
    } catch {
      // 非 JSON 响应仍保留 HTTP 状态供诊断。
    }
    const { status } = response;
    if (status < 200 || status >= 300) {
      throw providerError(status, envelope, redact, `AHOLO_HTTP_${status}`, `Aholo 返回 HTTP ${status}。`);
    }
    if (typeof envelope?.c !== 'string') {
      throw new RequestError(502, 'AHOLO_BAD_RESPONSE', `${label}响应缺少契约中的 c 字段。`);
    }
    if (envelope.c !== '0') throw providerError(status, envelope, redact, 'AHOLO_ERROR', 'Aholo 请求失败。');
    return envelope.d;
  }

  return {
    async upload(imagePath) {
      let uploaded;
      try {
        uploaded = await asset.uploadFile(imagePath, { signal: AbortSignal.timeout(120_000) });
      } catch (error) {
        onResponse?.('上传 SDK', error?.statusCode, redact(JSON.stringify(error?.body ?? error?.message)));
        throw providerError(error?.statusCode, error?.body, redact, 'AHOLO_UPLOAD_FAILED', '图片上传失败。');
      }
      onResponse?.('上传 SDK', undefined, redact(JSON.stringify(uploaded)));
      if (!httpUrl(uploaded?.url)) {
        throw new RequestError(502, 'AHOLO_BAD_UPLOAD_URL', '上传 SDK 未返回可用的 HTTP 图片 URL。');
      }
      return uploaded.url;
    },
    async create(img) {
      const d = await call('/lux3d/v1/generate/img-to-3d/task/create', '创建任务', {
        body: { img, version: config.version, faceCount, outputFormat: ['glb'] },
      });
      const id = typeof d === 'bigint' || Number.isSafeInteger(d) ? toTaskId(d) : null;
      if (!id) throw new RequestError(502, 'AHOLO_BAD_TASK_ID', '创建响应的 d 不是有效的整数任务 ID。');
      return id;
    },
    async query(id, timeoutMs) {
      const task = await call(`/lux3d/v1/generate/task/get?taskid=${id}`, '查询任务', { timeoutMs });
      if (!Number.isInteger(task?.status) || task.status < 0 || task.status > 6
          || (task.taskId !== undefined && toTaskId(task.taskId) !== id)) {
        throw new RequestError(502, 'AHOLO_BAD_TASK', '查询响应的任务 ID 或状态不符合契约。');
      }
      return task;
    },
    async download(task, target) {
      const urls = Array.isArray(task.outputs)
        ? task.outputs.map((item) => httpUrl(item?.content)).filter(Boolean)
        : [];
      const url = urls.find((item) => item.pathname.toLowerCase().endsWith('.glb'))
        ?? urls.find((item) => item.pathname.toLowerCase().includes('glb'));
      if (!url) throw new RequestError(502, 'GLB_URL_MISSING', '成功响应中未找到 GLB 下载地址。');

      const partial = `${target}.${randomUUID()}.part`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) {
          onResponse?.('下载 GLB', response.status, redact(await response.text()));
          throw new RequestError(502, `GLB_HTTP_${response.status}`, `下载 GLB 返回 HTTP ${response.status}。`);
        }
        onResponse?.('下载 GLB', response.status);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
        const file = await open(partial, 'r');
        try {
          const header = Buffer.alloc(12);
          const { bytesRead } = await file.read(header);
          const { size } = await file.stat();
          if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'glTF'
              || header.readUInt32LE(8) !== size) {
            throw new RequestError(502, 'GLB_INVALID', '下载内容的 GLB 文件头或长度无效。');
          }
        } finally {
          await file.close();
        }
        await rename(partial, target);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(502, 'GLB_DOWNLOAD_FAILED', '无法下载并保存 GLB 文件。');
      } finally {
        await rm(partial, { force: true });
      }
    },
  };
}

async function auditCall(logFile, job, operation, run) {
  const time = new Date().toISOString();
  const startedAt = performance.now();
  let status = 'failed';
  try {
    const result = await run();
    if (operation === 'create') job.taskId = result;
    status = operation === 'query' ? result.status : 'ok';
    return result;
  } finally {
    const entry = {
      time, operation,
      taskId: job.taskId === null ? null : jsonTaskId(job.taskId),
      status,
      durationMs: Math.round(performance.now() - startedAt),
      faceCount,
      version: job.version,
    };
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

async function pollTask(createdAt, query, { onStatus, onRetry } = {}) {
  const deadline = performance.now() + (createdAt + pollTimeoutMs - Date.now());
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new RequestError(504, 'TASK_TIMEOUT', '等待任务超时，已达 15 分钟。');
    return ms;
  };
  let retries = 0;
  while (true) {
    const timeoutMs = Math.min(remaining(), requestTimeoutMs);
    let task;
    try {
      task = await query(timeoutMs);
    } catch (error) {
      const wait = Math.min(2_000, remaining());
      if (!(error instanceof RequestError) || retries >= 3) throw error;
      retries += 1;
      onRetry?.(error, retries);
      await sleep(wait);
      continue;
    }
    retries = 0;
    onStatus?.(task);
    if (task.status >= 3) return task;
    await sleep(Math.min(12_000, remaining()));
  }
}

module.exports = {
  RequestError,
  auditCall,
  createLuxClient,
  jsonTaskId,
  makeRedactor,
  maxImageBytes,
  pollTask,
  readLuxConfig,
  toTaskId,
};
