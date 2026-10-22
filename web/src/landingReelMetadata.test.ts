import {describe, expect, it} from 'vitest';
import {LANDING_REEL_FPS, LANDING_REEL_FRAMES, landingReelShotAt} from './landingReelMetadata';
import manifest from './assets/gesso/landing-reel.json';
import {PRODUCT_GALLERY} from './productDescription';

describe('landing reel cut metadata', () => {
  it('names the real product on both sides of each cut and after looping', () => {
    let start = 0;
    for (const shot of manifest.shots) {
      expect(landingReelShotAt(start / LANDING_REEL_FPS).slug).toBe(shot.slug);
      expect(landingReelShotAt((start + shot.frameCount - 1) / LANDING_REEL_FPS).slug).toBe(shot.slug);
      start += shot.frameCount;
    }
    expect(landingReelShotAt(LANDING_REEL_FRAMES / LANDING_REEL_FPS).slug).toBe(manifest.shots[0].slug);
  });

  it('keeps every source tied to the existing model credit and a bounded source range', () => {
    for (const shot of manifest.shots) {
      expect(PRODUCT_GALLERY.find(item => item.slug === shot.slug)?.credit).toBeTruthy();
      expect(shot.sourceInFrame + shot.frameCount).toBeLessThanOrEqual(201);
    }
    expect(landingReelShotAt(Number.NaN).slug).toBe(manifest.shots[0].slug);
  });
});
