import * as THREE from 'three';

export const PREVIEW_TEXTURE_MAX_EDGE = 2048;

export interface PreviewTextureReport {
  resizedImages: number;
  failedImages: number;
  originalPixels: number;
  previewPixels: number;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Preview texture loading was superseded.', 'AbortError');
}

function materialTextures(root: THREE.Object3D): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const material = (object as THREE.Mesh).material;
    for (const entry of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(entry)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  return textures;
}

/** Resize only owned, decoded GLB image maps before the root is published.
 * Texture/source identity and sampling/color settings stay intact. The caller
 * owns every bitmap in this root, must bypass this for captures, and should abort
 * before disposing a superseded root. Original asset bytes remain unchanged. */
export async function capPreviewTextures(root: THREE.Object3D, {signal}: {signal?: AbortSignal} = {}): Promise<PreviewTextureReport> {
  const report: PreviewTextureReport = {resizedImages:0, failedImages:0, originalPixels:0, previewPixels:0};
  checkAbort(signal);
  if (typeof ImageBitmap === 'undefined' || typeof createImageBitmap !== 'function') return report;
  const images = new Map<ImageBitmap, Map<THREE.Source, Set<THREE.Texture>>>();
  const unsupportedImages = new Set<ImageBitmap>();
  const disposedTextures = new Set<THREE.Texture>();
  const listeners = new Map<THREE.Texture, () => void>();
  for (const texture of materialTextures(root)) {
    const image: unknown = texture.source.data;
    // Manual mip chains, render targets and non-bitmap maps retain their native
    // representation. Also protect any bitmap shared with one of those maps.
    const unsupported = texture.mipmaps.length > 0 || texture.isRenderTargetTexture
      || texture instanceof THREE.CubeTexture || texture instanceof THREE.CompressedTexture
      || texture instanceof THREE.DataTexture || texture instanceof THREE.VideoTexture;
    if (unsupported) {
      for (const candidate of Array.isArray(image) ? image : [image]) {
        if (candidate instanceof ImageBitmap) unsupportedImages.add(candidate);
      }
      continue;
    }
    if (!(image instanceof ImageBitmap) || !Number.isFinite(image.width) || !Number.isFinite(image.height)
      || image.width <= 0 || image.height <= 0 || Math.max(image.width, image.height) <= PREVIEW_TEXTURE_MAX_EDGE) continue;
    let sources = images.get(image);
    if (!sources) {sources = new Map(); images.set(image, sources);}
    let textures = sources.get(texture.source);
    if (!textures) {textures = new Set(); sources.set(texture.source, textures);}
    textures.add(texture);
    const disposed = () => disposedTextures.add(texture);
    texture.addEventListener('dispose', disposed);
    listeners.set(texture, disposed);
  }
  try {
    // Sequential resizes bound transient memory; release each old bitmap before
    // starting another. Source/image grouping avoids decoding cloned maps twice.
    for (const [image, sources] of images) {
      checkAbort(signal);
      if (unsupportedImages.has(image)) continue;
      const current = () => [...sources].every(([source, textures]) => source.data === image
        && [...textures].every(texture => texture.source === source && !disposedTextures.has(texture)));
      if (!current()) continue;
      const ratio = PREVIEW_TEXTURE_MAX_EDGE / Math.max(image.width, image.height);
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      let resized: ImageBitmap;
      try {
        resized = await createImageBitmap(image, {
          resizeWidth:width, resizeHeight:height, resizeQuality:'high',
          imageOrientation:'none', premultiplyAlpha:'none', colorSpaceConversion:'none',
        });
      } catch {
        checkAbort(signal);
        if (current()) report.failedImages++;
        continue;
      }
      if (signal?.aborted || !current()) {
        resized.close();
        checkAbort(signal);
        continue;
      }
      // A browser that ignores resizing must not cause a silently oversized or
      // distorted replacement, nor a premature close of the working source.
      if (resized.width !== width || resized.height !== height) {
        resized.close(); report.failedImages++; continue;
      }
      const originalPixels = image.width * image.height;
      for (const [source, textures] of sources) {
        source.data = resized;
        for (const texture of textures) texture.needsUpdate = true;
      }
      image.close();
      report.resizedImages++;
      report.originalPixels += originalPixels;
      report.previewPixels += width * height;
    }
    return report;
  } finally {
    for (const [texture, listener] of listeners) texture.removeEventListener('dispose', listener);
  }
}
