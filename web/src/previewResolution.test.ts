import {afterEach, describe, expect, it, vi} from 'vitest';
import {PREVIEW_MAX_EDGE, PREVIEW_MAX_PIXELS, PREVIEW_SETTLED_MAX_EDGE, PREVIEW_SETTLED_MAX_PIXELS,
  PREVIEW_SETTLED_MAX_PIXEL_RATIO, PREVIEW_SETTLE_DELAY_MS, PreviewQualityController, previewResolution} from './previewResolution';

afterEach(() => vi.useRealTimers());

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

describe('settled inspection resolution', () => {
  it('sharpens retina inspection within a 1.5× device cap without enlarging 1× displays', () => {
    expect(previewResolution(640,360,2,'settled')).toEqual({width:960,height:540,pixelRatio:1.5});
    expect(previewResolution(640,360,1,'settled')).toEqual({width:640,height:360,pixelRatio:1});
    expect(previewResolution(640,360,.75,'settled')).toEqual({width:480,height:270,pixelRatio:.75});
    expect(previewResolution(1280,720,3,'settled')).toEqual({width:1920,height:1080,pixelRatio:1.5});
  });

  it('keeps motion bounded while large settled views can reach full HD in either orientation', () => {
    expect(previewResolution(1920,1080,2,'interactive')).toEqual({width:1280,height:720,pixelRatio:2/3});
    expect(previewResolution(1920,1080,2,'settled')).toEqual({width:1920,height:1080,pixelRatio:1});
    expect(previewResolution(1080,1920,2,'settled')).toEqual({width:1080,height:1920,pixelRatio:1});
    const square=previewResolution(1200,1200,2,'settled');
    expect([square.width,square.height]).toEqual([1440,1440]);expect(square.pixelRatio).toBeCloseTo(1.2);
  });

  it('bounds settled panoramas, squares and extreme measurements by the same pixel policy', () => {
    for(const [width,height] of [[1,1],[320,200],[1200,1200],[7680,800],[1080,7680],[1e308,1e308]]) {
      const result=previewResolution(width,height,3,'settled');
      expect(Number.isFinite(result.pixelRatio)).toBe(true);
      expect(result.pixelRatio).toBeGreaterThan(0);
      expect(result.pixelRatio).toBeLessThanOrEqual(PREVIEW_SETTLED_MAX_PIXEL_RATIO);
      expect(Math.max(result.width,result.height)).toBeLessThanOrEqual(PREVIEW_SETTLED_MAX_EDGE);
      expect(result.width*result.height).toBeLessThanOrEqual(PREVIEW_SETTLED_MAX_PIXELS);
      expect(result).toEqual(previewResolution(width,height,3,'settled'));
    }
  });
});

describe('preview quality settling', () => {
  it('requests one sharper redraw after the last edit, with no idle render loop', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    expect(quality.quality).toBe('interactive');expect(vi.getTimerCount()).toBe(0);
    quality.activity();vi.advanceTimersByTime(100);quality.activity();vi.advanceTimersByTime(100);
    expect(changed).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS-100);
    expect(quality.quality).toBe('settled');expect(changed.mock.calls).toEqual([['settled']]);
    vi.advanceTimersByTime(10000);expect(changed).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    quality.dispose();
  });

  it('demotes immediately on resumed editing and promotes once after that gesture ends', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    quality.activity();vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);
    quality.activity();expect(quality.quality).toBe('interactive');
    quality.activity();expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);
    expect(changed.mock.calls).toEqual([['settled'],['interactive'],['settled']]);quality.dispose();
  });

  it('holds the motion budget throughout playback, including long gaps between frames', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    quality.activity();vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);
    quality.setPlayback(true);quality.activity();vi.advanceTimersByTime(5000);
    expect(quality.quality).toBe('interactive');expect(vi.getTimerCount()).toBe(0);
    expect(changed.mock.calls).toEqual([['settled'],['interactive']]);
    quality.setPlayback(false);vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS-1);
    expect(quality.quality).toBe('interactive');vi.advanceTimersByTime(1);
    expect(quality.quality).toBe('settled');quality.dispose();
  });

  it('cancels hidden/offscreen work and starts a fresh single delay on return', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    quality.activity();vi.advanceTimersByTime(100);quality.setSuspended(true);
    quality.activity();vi.advanceTimersByTime(5000);
    expect(changed).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    quality.setSuspended(false);quality.setSuspended(false);
    expect(vi.getTimerCount()).toBe(1);vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);
    expect(changed.mock.calls).toEqual([['settled']]);quality.dispose();
  });

  it('honors data saving when enabled at rest and throughout repeated input', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    quality.activity();vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);quality.setSaveData(true);
    for(let index=0;index<3;index++){quality.activity();vi.advanceTimersByTime(1000);}
    expect(quality.quality).toBe('interactive');expect(vi.getTimerCount()).toBe(0);
    quality.setSaveData(false);expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PREVIEW_SETTLE_DELAY_MS);expect(quality.quality).toBe('settled');quality.dispose();
  });

  it('keeps overlapping holds independent and ignores all work after disposal', () => {
    vi.useFakeTimers();const changed=vi.fn(),quality=new PreviewQualityController(changed);
    quality.setSaveData(true);quality.setPlayback(true);quality.setSuspended(true);
    quality.setSuspended(false);quality.setPlayback(false);quality.activity();
    expect(vi.getTimerCount()).toBe(0);quality.setSaveData(false);expect(vi.getTimerCount()).toBe(1);
    quality.dispose();quality.dispose();quality.activity();quality.setSuspended(true);quality.setPlayback(true);quality.setSaveData(true);
    vi.advanceTimersByTime(10000);expect(changed).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
});
