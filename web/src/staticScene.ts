import {addImageShot, setShotFrames, type ImageShotAsset, type Shot} from './sequence';
import type {FilmTextCard} from './filmTextCard';

/** Commit a static scene once its canonical image is ready. Text remains editable source. */
export function applyStaticScene(scene: any, asset: ImageShotAsset, input: {name: string; durationFrames: number; textCard?: FilmTextCard},
  destination: {shotId?: string; afterId?: string} = {}): string {
  const existing = destination.shotId ? scene.shots.find((shot: Shot) => shot.id === destination.shotId) : null;
  if (destination.shotId && (!existing || existing.kind !== 'image')) throw new Error('This static scene is no longer available.');
  let id = destination.shotId;
  if (id) setShotFrames(scene, id, input.durationFrames);
  else id = addImageShot(scene, asset, input.name, destination.afterId, input.durationFrames);
  const shot = scene.shots.find((item: Shot) => item.id === id);
  shot.name = input.name.trim().slice(0, 80) || (input.textCard ? 'Text' : 'Image');
  shot.image = {asset: structuredClone(asset), fit: input.textCard ? 'contain' : existing?.image?.fit ?? 'contain',
    ...(input.textCard ? {textCard: structuredClone(input.textCard)} : {})};
  return id!;
}
