import {assetUrl, isStaticDemo} from './runtime';
import type {ProductDecal} from './decals';

export type ArtworkAsset = {path: string; sha256: string; format: 'png'; width: number; height: number};
export type PartArtwork = {componentId: string; partId: string; finish: 'paper' | 'original'; asset: ArtworkAsset};
export const ARTWORK_LIMIT_BYTES = 32 * 1024 * 1024;

export function artworkAssetUrl(asset: ArtworkAsset): string {
  if (!/^[0-9a-f]{64}$/.test(asset.sha256) || asset.path !== `assets/${asset.sha256}.png` || asset.format !== 'png')
    throw new Error('The artwork asset is invalid.');
  return assetUrl(asset.path);
}

export async function uploadArtwork(blob: Blob, filename: string, signal?: AbortSignal): Promise<ArtworkAsset> {
  if(isStaticDemo)throw new Error('Uploading artwork requires the local server. The supplied artwork remains unchanged.');
  if (!blob.size || blob.size > ARTWORK_LIMIT_BYTES) throw new Error('Use an image smaller than 32 MB.');
  if (!/\.(?:png|jpe?g|webp)$/i.test(filename)) throw new Error('Choose a PNG, JPEG or WebP image.');
  const response = await fetch('/api/artwork/import', {method: 'POST', signal,
    headers: {'X-Product-Suite': '1', 'X-Asset-Filename': `artwork.${filename.split('.').at(-1)!.toLowerCase()}`, 'Content-Type': 'application/octet-stream'}, body: blob});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not import this artwork.');
  artworkAssetUrl(result);
  if (![result.width, result.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096))
    throw new Error('The artwork dimensions are invalid.');
  return result;
}

/** Commit the letterforms once; preview and export consume this same image. */
export async function canonicalizeDecalArtwork(decal: ProductDecal, signal?: AbortSignal): Promise<ProductDecal> {
  if(isStaticDemo)throw new Error('Creating label artwork requires the local server.');
  signal?.throwIfAborted();
  const faces = await document.fonts.load('500 32px "Studio Sans"');
  if (!faces.length || faces.some(face => face.status !== 'loaded'))
    throw new Error('The label font is still loading. Try again when the preview is ready.');
  signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 1024;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Artwork drawing is unavailable.');
    context.fillStyle = '#faf9f4'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#344036'; context.textAlign = 'center'; context.textBaseline = 'middle';
    const draw = (text: string, y: number, fraction: number) => {
      let size = canvas.height * fraction;
      context.font = `500 ${size}px "Studio Sans"`;
      const measured = context.measureText(text).width;
      if (measured > canvas.width * .84) {size *= canvas.width * .84 / measured; context.font = `500 ${size}px "Studio Sans"`;}
      context.fillText(text, canvas.width / 2, canvas.height * y);
    };
    draw(decal.text, .37, .24); draw(decal.subtitle, .73, .065);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare the artwork.')), 'image/png'));
    signal?.throwIfAborted();
    return {...decal, artwork: await uploadArtwork(blob, 'label-text.png', signal)};
  } finally {canvas.width = canvas.height = 1;}
}

export function partArtwork(scene: any, partId: string): PartArtwork | undefined {
  return scene?.product?.artwork?.find((item: PartArtwork) => item.partId === partId);
}

export function artworkComponentId(scene: any, partId: string): string | null {
  const component = scene?.product?.components?.find((item: any) => item.shape === 'mesh'
    ? partId.startsWith(`${item.id}::node:`) && /^(0|[1-9]\d*)$/.test(partId.slice(`${item.id}::node:`.length))
      && item.sourceNodes?.some((node: any) => node.nodeIndex === Number(partId.slice(`${item.id}::node:`.length)) && node.hasMesh)
    : item.id === partId);
  return component?.id ?? null;
}

export function setPartArtwork(scene: any, replacement: PartArtwork): void {
  if (artworkComponentId(scene, replacement.partId) !== replacement.componentId)
    throw new Error('Select one product mesh to replace its artwork.');
  artworkAssetUrl(replacement.asset);
  if (!['paper', 'original'].includes(replacement.finish)) throw new Error('Choose a label finish.');
  const entries: PartArtwork[] = scene.product.artwork ?? [];
  scene.product.artwork = [...entries.filter(item => item.partId !== replacement.partId), structuredClone(replacement)];
}

export function restorePartArtwork(scene: any, partId: string): void {
  scene.product.artwork = (scene.product.artwork ?? []).filter((item: PartArtwork) => item.partId !== partId);
}
