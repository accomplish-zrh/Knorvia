import * as THREE from './assets/three.module.js';

// Decode and resize away from the render loop. The source artwork stays intact;
// the GPU only needs the resolution visible on a curved panel at this viewport.
export function loadDisplayTexture(url, width, onLoad, onError) {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  const controller = new AbortController();
  let disposed = false;
  texture.addEventListener('dispose', () => {
    disposed = true;
    controller.abort();
    texture.image?.close?.();
  });
  const accept = image => {
    if (disposed) { image.close?.(); return; }
    texture.image = image;
    texture.needsUpdate = true;
    onLoad(texture);
  };
  const fallback = () => {
    if (disposed) return;
    new THREE.ImageLoader().load(url, accept, undefined, error => {
      if (!disposed) onError(error);
    });
  };
  if (typeof createImageBitmap !== 'function') fallback();
  else fetch(url, { signal: controller.signal }).then(response => {
    if (!response.ok) throw new Error(`Artwork unavailable (${response.status})`);
    return response.blob();
  }).then(blob => createImageBitmap(blob, {
    resizeWidth: width, resizeQuality: 'high', imageOrientation: 'flipY',
    premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  })).then(accept).catch(fallback);
  return texture;
}
