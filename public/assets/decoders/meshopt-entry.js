// model-viewer loads this entry as a classic script and waits for decoder.ready.
globalThis.MeshoptDecoder = {
  ready: import('./meshopt_decoder.module.js').then(async ({ MeshoptDecoder }) => {
    await MeshoptDecoder.ready;
    Object.assign(globalThis.MeshoptDecoder, MeshoptDecoder);
  }),
};
