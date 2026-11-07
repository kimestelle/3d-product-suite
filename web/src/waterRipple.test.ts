import {describe, expect, it} from 'vitest';
import {WaterRippleMap} from './waterRipple';

describe('spot water ripple', () => {
  it('replays the same sampled frame and skips identical uploads', () => {
    const map = new WaterRippleMap({strength:.8, scale:11, speed:.7}, 0);
    const initial = map.texture.image.data.slice();
    const version = map.texture.version;
    map.update(0);
    expect(map.texture.version).toBe(version);
    map.update(1);
    expect(map.texture.version).toBe(version + 1);
    expect(map.texture.image.data.some((value:number, index:number) => value !== initial[index])).toBe(true);
    map.update(0);
    expect(map.texture.image.data).toEqual(initial);
    map.dispose();
  });

  it('keeps static water fixed and rebuilds the cookie when the scale changes', () => {
    const map = new WaterRippleMap({strength:1, scale:10, speed:0}, 0);
    const version = map.texture.version;
    map.update(15);
    expect(map.texture.version).toBe(version);
    map.configure({strength:1, scale:20, speed:0}, 15);
    expect(map.texture.version).toBe(version + 1);
    const values = Array.from(map.texture.image.data as Uint8Array).filter((_, index) => index % 4 === 0);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(Math.round(.16 * 255));
    expect(Math.max(...values)).toBe(255);
    map.dispose();
  });
});
