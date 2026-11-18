const gateways = {
  A: 'https://api.aholo.cn',
  B: 'https://api.aholo3d.cn',
};
const listPath = '/lux3d/v1/generate/task/list?page=1&pagesize=5';
const requestTimeoutMs = 15_000;

async function main() {
  const apiKey = process.env.AHOLO_API_KEY?.trim();
  if (!apiKey) {
    console.error('缺少环境变量 AHOLO_API_KEY。');
    process.exitCode = 1;
    return;
  }

  if (typeof fetch !== 'function') {
    console.error('请使用 Node.js 18 或更高版本。');
    process.exitCode = 1;
    return;
  }

  const jsonEscapedKey = JSON.stringify(apiKey).slice(1, -1);
  let gatewayVerified = false;

  for (const [name, base] of Object.entries(gateways)) {
    const url = `${base}${listPath}`;
    const signal = AbortSignal.timeout(requestTimeoutMs);
    console.log(`\n[网关 ${name}] GET ${url}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
        signal,
      });

      console.log(`HTTP ${response.status}`);
      const body = await response.text();
      console.log('响应体');
      console.log(body.replaceAll(jsonEscapedKey, '[已隐藏]').replaceAll(apiKey, '[已隐藏]'));

      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        // 网关也可能返回 HTML 或纯文本，前面已输出响应内容。
      }

      const success = response.ok && envelope?.c === '0';
      gatewayVerified ||= success;
      console.log(success ? '列表接口验证通过。' : '列表接口验证失败。');
    } catch {
      // 请求异常可能包含请求头，仅输出固定提示。
      console.error(signal.aborted ? '请求或读取响应体超时。' : '连接失败或响应体读取中断。');
    }
  }

  process.exitCode = gatewayVerified ? 0 : 1;
}

main();
