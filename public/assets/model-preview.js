let viewerSetup;

function prepareViewer() {
  viewerSetup ??= (async () => {
    let timer;
    try {
      const Viewer = customElements.get('model-viewer') ?? await Promise.race([
        customElements.whenDefined('model-viewer'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('model-viewer unavailable')), 8_000);
        }),
      ]);
      Viewer.dracoDecoderLocation = new URL('./decoders/draco/', import.meta.url).href;
      Viewer.ktx2TranscoderLocation = new URL('./decoders/basis/', import.meta.url).href;
      Viewer.meshoptDecoderLocation = new URL('./decoders/meshopt-entry.js', import.meta.url).href;
      Viewer.modelCacheSize = 1;
    } finally {
      clearTimeout(timer);
    }
  })();
  return viewerSetup;
}

export function createModelPreview(root, { ar = false, emptyMessage = '请选择一个模型。' } = {}) {
  root.innerHTML = `
    <div class="visual-frame">
      <div class="viewer-canvas"></div>
      <p class="viewer-message" role="status"></p>
      <div class="viewer-loading" hidden>
        <span>模型加载中 0%</span>
        <progress max="100" value="0" aria-label="模型加载进度"></progress>
      </div>
    </div>
    <div class="viewer-controls" hidden>
      <button class="button button-outline" type="button" aria-pressed="false" hidden>自动旋转</button>
      <a class="button button-primary" download>下载 GLB</a>
      <span class="viewer-hint" hidden>拖动旋转，滚轮或双指缩放</span>
    </div>`;

  const canvas = root.querySelector('.viewer-canvas');
  const message = root.querySelector('.viewer-message');
  const loading = root.querySelector('.viewer-loading');
  const progress = loading.querySelector('progress');
  const progressLabel = loading.querySelector('span');
  const controls = root.querySelector('.viewer-controls');
  const rotate = controls.querySelector('button');
  const download = controls.querySelector('a');
  const hint = controls.querySelector('.viewer-hint');
  let viewer;
  let revision = 0;

  function clear(text = emptyMessage) {
    revision += 1;
    viewer?.removeAttribute('src');
    viewer = undefined;
    canvas.replaceChildren();
    controls.hidden = true;
    loading.hidden = true;
    rotate.hidden = true;
    hint.hidden = true;
    rotate.setAttribute('aria-pressed', 'false');
    download.removeAttribute('href');
    message.classList.remove('is-error');
    message.textContent = text;
    message.hidden = !text;
  }

  function fail(text) {
    loading.hidden = true;
    rotate.hidden = true;
    hint.hidden = true;
    message.textContent = text;
    message.classList.add('is-error');
    message.hidden = false;
  }

  function setProgress(value) {
    progress.value = value;
    progressLabel.textContent = `模型加载中 ${value}%`;
  }

  rotate.addEventListener('click', () => {
    const enabled = !viewer.hasAttribute('auto-rotate');
    viewer.toggleAttribute('auto-rotate', enabled);
    rotate.setAttribute('aria-pressed', String(enabled));
  });

  async function show({ url, title, poster, filename }) {
    clear('');
    const selected = revision;
    download.href = url;
    download.download = filename;
    controls.hidden = false;
    loading.hidden = false;
    setProgress(0);

    try {
      await prepareViewer();
    } catch {
      if (selected === revision) fail('3D 查看器加载失败。可以先下载 GLB。');
      return;
    }
    if (selected !== revision) return;

    viewer = document.createElement('model-viewer');
    viewer.setAttribute('alt', title);
    viewer.setAttribute('camera-controls', '');
    viewer.setAttribute('touch-action', 'pan-y');
    viewer.setAttribute('shadow-intensity', '0.8');
    viewer.setAttribute('environment-image', 'neutral');
    viewer.setAttribute('camera-orbit', '26deg 69deg auto');
    viewer.setAttribute('interaction-prompt', 'none');
    viewer.setAttribute('loading', 'eager');
    if (poster) viewer.setAttribute('poster', poster);
    const nativeProgress = document.createElement('span');
    nativeProgress.slot = 'progress-bar';
    nativeProgress.hidden = true;
    viewer.append(nativeProgress);

    if (ar) {
      viewer.setAttribute('ar', '');
      viewer.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
      const arButton = document.createElement('button');
      arButton.type = 'button';
      arButton.slot = 'ar-button';
      arButton.className = 'button button-outline model-ar';
      arButton.textContent = 'AR 查看';
      // model-viewer 的 AR 插槽仅在当前设备可启动 AR 时显示。
      viewer.append(arButton);
    }

    viewer.addEventListener('progress', ({ detail }) => {
      if (selected !== revision || loading.hidden || !Number.isFinite(detail?.totalProgress)) return;
      setProgress(Math.max(0, Math.min(100, Math.round(detail.totalProgress * 100))));
    });
    viewer.addEventListener('load', () => {
      if (selected !== revision) return;
      loading.hidden = true;
      message.hidden = true;
      rotate.hidden = false;
      hint.hidden = false;
    });
    viewer.addEventListener('error', () => {
      if (selected === revision) fail('3D 模型加载失败。请检查文件，或下载 GLB 查看。');
    });
    canvas.append(viewer);
    viewer.src = url;
  }

  clear();
  return { show, clear };
}
