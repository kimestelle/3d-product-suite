import manifest from './assets/gesso/landing-reel.json';
import {PRODUCT_GALLERY} from './productDescription';

export const LANDING_REEL_FPS = manifest.fps;
export const LANDING_REEL_FRAMES = manifest.shots.reduce((total, shot) => total + shot.frameCount, 0);
export const LANDING_REEL_VERSION = manifest.version;

/** Same frame counts as the encoder, including seeking and the loop boundary. */
export function landingReelShotAt(seconds: number) {
  const frame = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * LANDING_REEL_FPS) % LANDING_REEL_FRAMES;
  let end = 0;
  const shot = manifest.shots.find(item => {end += item.frameCount; return frame < end;}) ?? manifest.shots[0];
  return PRODUCT_GALLERY.find(item => item.slug === shot.slug) ?? PRODUCT_GALLERY[0];
}
