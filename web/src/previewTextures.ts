import * as THREE from 'three';

export const PREVIEW_TEXTURE_MAX_EDGE = 2048;

export interface PreviewTextureOptions {
  signal?: AbortSignal;
  /** Owned bitmap edge limit. Source asset bytes are never changed. */
  maxEdge?: number;
  /** Combined pixels across unique, resizable bitmaps, including smaller maps. */
  maxTotalPixels?: number;
}

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
export async function capPreviewTextures(root: THREE.Object3D, {
  signal, maxEdge = PREVIEW_TEXTURE_MAX_EDGE, maxTotalPixels,
}: PreviewTextureOptions = {}): Promise<PreviewTextureReport> {
  const report: PreviewTextureReport = {resizedImages:0, failedImages:0, originalPixels:0, previewPixels:0};
  checkAbort(signal);
  if (!Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > 8192) {
    throw new RangeError('Preview texture maxEdge must be an integer from 256 to 8192.');
  }
  if (maxTotalPixels !== undefined && (!Number.isInteger(maxTotalPixels)
    || maxTotalPixels < 65536 || maxTotalPixels > 64 * 1024 * 1024)) {
    throw new RangeError('Preview texture maxTotalPixels must be an integer from 65536 to 67108864.');
  }
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
      || image.width <= 0 || image.height <= 0
      || (maxTotalPixels === undefined && Math.max(image.width, image.height) <= maxEdge)) continue;
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
    const sizes = new Map<ImageBitmap, {width:number; height:number}>();
    let totalPixels = 0;
    for (const image of images.keys()) {
      if (unsupportedImages.has(image)) continue;
      const ratio = Math.min(1, maxEdge / Math.max(image.width, image.height));
      // Keep historical rounding without a total budget. With a budget, round
      // down so many small maps cannot collectively exceed the requested cap.
      const round = maxTotalPixels === undefined ? Math.round : Math.floor;
      const width = Math.max(1, round(image.width * ratio));
      const height = Math.max(1, round(image.height * ratio));
      sizes.set(image, {width, height});
      totalPixels += width * height;
    }
    let budgetScale = maxTotalPixels === undefined || totalPixels <= maxTotalPixels
      ? 1 : Math.sqrt(maxTotalPixels / totalPixels);
    if (maxTotalPixels !== undefined && totalPixels > maxTotalPixels) {
      if (sizes.size > maxTotalPixels) throw new RangeError('Too many bitmap images for this preview texture budget.');
      const pixelsAt = (scale:number) => [...sizes.values()].reduce((sum, size) => sum
        + Math.max(1, Math.floor(size.width * scale)) * Math.max(1, Math.floor(size.height * scale)), 0);
      // Extremely thin maps can reach the one-pixel minimum on one axis. In
      // that case the square-root estimate alone would exceed the pixel cap.
      if (pixelsAt(budgetScale) > maxTotalPixels) {
        let lower = 0, upper = budgetScale;
        for (let attempt = 0; attempt < 32; attempt++) {
          const middle = (lower + upper) / 2;
          if (pixelsAt(middle) > maxTotalPixels) upper = middle;
          else lower = middle;
        }
        budgetScale = lower;
      }
    }
    // Sequential resizes bound transient memory; release each old bitmap before
    // starting another. Source/image grouping avoids decoding cloned maps twice.
    for (const [image, sources] of images) {
      checkAbort(signal);
      if (unsupportedImages.has(image)) continue;
      const current = () => [...sources].every(([source, textures]) => source.data === image
        && [...textures].every(texture => texture.source === source && !disposedTextures.has(texture)));
      if (!current()) continue;
      const size = sizes.get(image)!;
      const width = Math.max(1, Math.floor(size.width * budgetScale));
      const height = Math.max(1, Math.floor(size.height * budgetScale));
      if (width === image.width && height === image.height) continue;
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
