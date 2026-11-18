const { mkdir, stat } = require('node:fs/promises');
const { extname, join, resolve } = require('node:path');
const { auditCall, createLuxClient, makeRedactor, maxImageBytes, pollTask, readLuxConfig } = require('./lux3d');

const taskStatuses = ['初始化', '运行中', '等待结果', '成功', '失败', '派发失败', '已取消'];
const redact = makeRedactor(process.env.AHOLO_API_KEY?.trim());

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.log('用法：node test-generate.js <图片路径> --confirm');
    console.log('添加 --confirm 后会上传图片并创建一个计费任务。');
    return;
  }

  const paths = args.filter((arg) => arg !== '--confirm');
  if (args.length !== 2 || paths.length !== 1 || paths[0].startsWith('--')) {
    throw new Error('请提供一张图片的路径和一个 --confirm 参数。');
  }
  const config = readLuxConfig();
  const imagePath = resolve(paths[0]);
  if (!['.jpg', '.jpeg', '.png'].includes(extname(imagePath).toLowerCase())) {
    throw new Error('请选择 JPG 或 PNG 图片。');
  }
  const image = await stat(imagePath);
  if (!image.isFile() || image.size === 0 || image.size > maxImageBytes) {
    throw new Error('请选择一张大于 0 字节且不超过 5 MB 的本地图片。');
  }

  const lux = await createLuxClient(config, {
    onResponse(label, status, body) {
      console.log(status === undefined ? `[${label}]` : `[${label}] HTTP ${status}`);
      if (body !== undefined) console.log(body);
    },
  });
  const generatedDir = join(__dirname, 'public', 'generated');
  const logsDir = join(__dirname, 'logs');
  await Promise.all([mkdir(generatedDir, { recursive: true }), mkdir(logsDir, { recursive: true })]);

  const logFile = join(logsDir, 'calls.jsonl');
  const job = { version: config.version, taskId: null };
  const img = await auditCall(logFile, job, 'upload', () => lux.upload(imagePath));
  await auditCall(logFile, job, 'create', () => lux.create(img));
  console.log(`任务 ID ${job.taskId}`);

  const task = await pollTask(Date.now(), (timeout) => auditCall(logFile, job, 'query', () => lux.query(job.taskId, timeout)), {
    onStatus({ status }) {
      console.log(`任务 ${job.taskId} 状态 ${status} ${taskStatuses[status]}`);
    },
    onRetry(error, retry) {
      console.error(`${redact(error.message)} 2 秒后重试查询（${retry}/3）。`);
    },
  });
  if (task.status !== 3) {
    throw new Error(`任务 ${job.taskId} 已结束，状态 ${task.status} ${taskStatuses[task.status]}。`);
  }

  const file = join(generatedDir, `${job.taskId}.glb`);
  await auditCall(logFile, job, 'download', () => lux.download(task, file));
  console.log(`GLB 已保存 ${file}`);
}

main().catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('请先在项目目录运行 npm.cmd install @manycore/aholo-sdk-asset。');
  } else {
    console.error(redact(error.c ? `${error.c} ${error.message}` : (error.message ?? '运行失败。')));
  }
  process.exitCode = 1;
});
