const { createHash, timingSafeEqual } = require('node:crypto');
const { appendFile, lstat, mkdir, mkdtemp, rm, rmdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const express = require('express');
const multer = require('multer');
const {
  RequestError, auditCall, createLuxClient, jsonTaskId, maxImageBytes, pollTask, readLuxConfig, toTaskId,
} = require('./lux3d');
const { openTaskStore } = require('./task-store');

const descriptions = ['排队中', '生成中', '等待结果', '完成', '生成失败', '派发失败', '已取消'];
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpgSignature = Buffer.from('ffd8ff', 'hex');
const parseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: 1, fields: 0, parts: 1 },
}).single('image');

function receiveImage(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return next(new RequestError(415, 'MULTIPART_REQUIRED', '请用 multipart 表单上传图片。'));
  }
  parseUpload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new RequestError(413, 'IMAGE_TOO_LARGE', '图片大小不得超过 5 MB。'));
    }
    next(new RequestError(400, 'INVALID_MULTIPART', '请通过 image 字段提交一张图片。'));
  });
}

function imageExtension(file) {
  if (!file?.size) throw new RequestError(400, 'IMAGE_REQUIRED', '请选择一张图片。');
  if (file.mimetype === 'image/png' && file.buffer.subarray(0, 8).equals(pngSignature)) return '.png';
  if (file.mimetype === 'image/jpeg' && file.buffer.subarray(0, 3).equals(jpgSignature)) return '.jpg';
  throw new RequestError(415, 'INVALID_IMAGE_TYPE', '图片必须是 JPG 或 PNG。');
}

const hashCode = (code) => createHash('sha256').update(code).digest();

async function createBackend({ root = __dirname, accessCode, version, lux }) {
  const publicDir = join(root, 'public');
  const generatedDir = join(publicDir, 'generated');
  const logsDir = join(root, 'logs');
  const logFile = join(logsDir, 'calls.jsonl');
  await Promise.all([mkdir(generatedDir, { recursive: true }), mkdir(logsDir, { recursive: true })]);
  await appendFile(logFile, '');
  const store = openTaskStore(join(logsDir, 'tasks.sqlite'));
  const workers = new Map();
  const pathForModel = (id) => join(generatedDir, `${id}.glb`);
  const accessHash = hashCode(accessCode);
  const encodedAccessHash = hashCode(encodeURIComponent(accessCode));

  function requireCode(req, _res, next) {
    const presentedHash = hashCode(req.get('X-Access-Code') ?? '');
    if (!timingSafeEqual(accessHash, presentedHash) && !timingSafeEqual(encodedAccessHash, presentedHash)) {
      return next(new RequestError(401, 'INVALID_ACCESS_CODE', '访问口令有误。'));
    }
    next();
  }

  async function hasModel(id) {
    try {
      const file = await lstat(pathForModel(id));
      return file.isFile() && file.size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function track(job) {
    try {
      if (await hasModel(job.taskId)) {
        store.setStatus(job.taskId, 3);
        return;
      }
      const task = await pollTask(job.createdAt, (timeout) => auditCall(logFile, job, 'query', () => lux.query(job.taskId, timeout)), {
        onStatus: ({ status }) => {
          // 模型文件写完再对前端标记完成。
          if (status <= 3) store.setStatus(job.taskId, Math.min(status, 2));
        },
      });
      if (task.status === 3) {
        await auditCall(logFile, job, 'download', () => lux.download(task, pathForModel(job.taskId)));
      }
      const failure = task.status > 3 ? { c: String(task.status), message: descriptions[task.status] } : undefined;
      store.setStatus(job.taskId, task.status, failure);
    } catch (error) {
      const failure = error instanceof RequestError
        ? error
        : new RequestError(500, 'TASK_TRACKING_FAILED', '跟踪任务时发生了本地错误。');
      store.setStatus(job.taskId, 4, failure);
    }
  }

  function startTracking(job) {
    if (job.status >= 3 || workers.has(job.taskId)) return;
    const work = track(job)
      .catch(() => console.error(`无法保存任务 ${job.taskId} 的状态。`))
      .finally(() => workers.delete(job.taskId));
    workers.set(job.taskId, work);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.use('/api', requireCode);

  app.post('/api/generate', receiveImage, async (req, res) => {
    const extension = imageExtension(req.file);
    const retryAfter = store.reserve(req.ip);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      throw new RequestError(429, 'IP_RATE_LIMIT', '此 IP 每小时最多提交 5 次生成，请稍后再试。');
    }

    const temporaryDir = await mkdtemp(join(tmpdir(), 'aholo-upload-'));
    const imagePath = join(temporaryDir, `image${extension}`);
    const job = { version, taskId: null };
    try {
      await writeFile(imagePath, req.file.buffer, { flag: 'wx' });
      const img = await auditCall(logFile, job, 'upload', () => lux.upload(imagePath));
      const createdAt = Date.now();
      try {
        await auditCall(logFile, job, 'create', () => lux.create(img));
      } catch (error) {
        if (job.taskId === null) throw error;
        console.error(`任务 ${job.taskId} 已创建，写入调用日志失败。`);
      }
      const savedJob = store.add(job.taskId, version, createdAt);
      startTracking(savedJob);
      res.status(202).json({ taskId: jsonTaskId(job.taskId) });
    } finally {
      try {
        await rm(imagePath, { force: true });
        await rmdir(temporaryDir);
      } catch {
        console.error('清理上传临时文件失败。');
      }
    }
  });

  app.get('/api/task/:id', async (req, res) => {
    const id = toTaskId(req.params.id);
    if (!id) throw new RequestError(400, 'INVALID_TASK_ID', '任务 ID 必须是正整数。');
    const task = store.get(id);
    const available = await hasModel(id);
    if (!task && !available) throw new RequestError(404, 'TASK_NOT_FOUND', '找不到此任务。');

    let status = available ? 3 : task.status;
    let failure = task?.c ? { c: task.c, m: task.m } : {};
    if (!available && status === 3) {
      status = 4;
      failure = { c: 'GLB_FILE_MISSING', m: '此任务的本地 GLB 文件已丢失。' };
    }
    res.json({
      taskId: jsonTaskId(id),
      status,
      description: descriptions[status],
      elapsedMs: task ? Math.max(0, (task.finishedAt ?? Date.now()) - task.createdAt) : null,
      glbUrl: available ? `/generated/${id}.glb` : null,
      ...(status === 3 ? {} : failure),
    });
  });

  app.get('/generated/:filename', requireCode, async (req, res) => {
    const { filename } = req.params;
    const id = filename.endsWith('.glb') ? toTaskId(filename.slice(0, -4)) : null;
    if (!id || !(await hasModel(id))) throw new RequestError(404, 'GLB_NOT_FOUND', '找不到此 GLB 文件。');
    res.type('model/gltf-binary').sendFile(`${id}.glb`, { root: generatedDir, cacheControl: false });
  });

  for (const file of ['index.html', 'generate.html', 'layout.html', 'style.css', 'app.js', 'generate.js', 'models.json']) {
    const routes = file === 'index.html' ? ['/', '/index.html'] : `/${file}`;
    app.get(routes, (_req, res) => res.sendFile(file, { root: publicDir }));
  }
  app.use('/assets', express.static(join(publicDir, 'assets'), { index: false, redirect: false }));

  app.use((_req, _res, next) => next(new RequestError(404, 'NOT_FOUND', '找不到页面或接口。')));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof RequestError) return res.status(error.status).json({ c: error.c, m: error.message });
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({ c: 'INVALID_REQUEST', m: '请求地址无效或文件不存在。' });
    }
    console.error('处理请求时发生了本地错误。');
    res.status(500).json({ c: 'INTERNAL_ERROR', m: '服务暂时无法完成请求。' });
  });

  return {
    app,
    resumePending() {
      for (const job of store.pending()) startTracking(job);
    },
    async close() {
      await Promise.all(workers.values());
      store.close();
    },
  };
}

async function main() {
  const accessCode = process.env.ACCESS_CODE?.trim();
  if (!accessCode) throw new Error('缺少环境变量 ACCESS_CODE。');
  const config = readLuxConfig();
  if (accessCode === config.apiKey) throw new Error('ACCESS_CODE 和 AHOLO_API_KEY 必须分别设置。');
  const port = Number(process.env.PORT?.trim() || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT 必须是 1 到 65535 的整数。');
  const lux = await createLuxClient(config);
  const backend = await createBackend({ accessCode, version: config.version, lux });
  const server = backend.app.listen(port, '127.0.0.1', (error) => {
    if (error) {
      if (error.code === 'EADDRINUSE') console.error('端口已占用，请更换 PORT。');
      else console.error('本地服务启动失败。');
      process.exitCode = 1;
      void backend.close();
      return;
    }
    backend.resumePending();
    console.log(`后端已启动 http://127.0.0.1:${port}`);
  });
  server.requestTimeout = 120_000;
}

if (require.main === module) {
  main().catch((error) => {
    const safeConfigError = error instanceof Error && /^(缺少环境变量|请将 AHOLO_BASE|LUX_VERSION|ACCESS_CODE|PORT)/.test(error.message);
    console.error(safeConfigError ? error.message : '本地服务启动失败，请检查依赖和项目目录的写入权限。');
    process.exitCode = 1;
  });
}

module.exports = { createBackend };
