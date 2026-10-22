import {describe, expect, it} from 'vitest';
import {PREVIEW_MAX_EDGE, PREVIEW_MAX_PIXELS, previewResolution} from './previewResolution';

describe('interactive preview resolution', () => {
  it('uses one device pixel per CSS pixel on small retina viewports', () => {
    expect(previewResolution(640, 360, 2)).toEqual({width:640, height:360, pixelRatio:1});
    expect(previewResolution(640, 360, .75)).toEqual({width:480, height:270, pixelRatio:.75});
  });

  it('caps full HD and portrait viewports without changing their proportions', () => {
    expect(previewResolution(1920, 1080, 2)).toEqual({width:1280, height:720, pixelRatio:2 / 3});
    expect(previewResolution(1080, 1920, 2)).toEqual({width:720, height:1280, pixelRatio:2 / 3});
  });

  it('applies the area budget to square windows and the edge budget to wide windows', () => {
    expect(previewResolution(1200, 1200)).toEqual({width:960, height:960, pixelRatio:.8});
    const wide = previewResolution(3840, 800);
    expect(wide.width).toBe(1280);
    expect(wide.height).toBe(266);
    expect(Math.abs(wide.height - 800 * wide.pixelRatio)).toBeLessThan(1);
  });

  it('recalculates deterministically after resize and never exceeds either budget', () => {
    for (const width of [1, 180, 640, 1200, 2560, 7680]) {
      for (const height of [1, 360, 960, 2160, 4320]) {
        const result = previewResolution(width, height, 3);
        expect(result).toEqual(previewResolution(width, height, 3));
        expect(result.width).toBeGreaterThanOrEqual(1);
        expect(result.height).toBeGreaterThanOrEqual(1);
        expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(PREVIEW_MAX_EDGE);
        expect(result.width * result.height).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
        expect(result.pixelRatio).toBeGreaterThan(0);
        expect(result.pixelRatio).toBeLessThanOrEqual(1);
        expect(Math.abs(result.width - width * result.pixelRatio)).toBeLessThanOrEqual(1);
        expect(Math.abs(result.height - height * result.pixelRatio)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps hidden, invalid and extreme measurements finite and positive', () => {
    for (const [width, height, ratio] of [[0, 0, 0], [-20, NaN, Infinity], [Infinity, -1, NaN]]) {
      expect(previewResolution(width, height, ratio)).toEqual({width:1, height:1, pixelRatio:1});
    }
    const huge = previewResolution(1e308, 1e308, 2);
    expect(Number.isFinite(huge.pixelRatio)).toBe(true);
    expect(huge.pixelRatio).toBeGreaterThan(0);
    expect(huge.width * huge.height).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
  });
});
