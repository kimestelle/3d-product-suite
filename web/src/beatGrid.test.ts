import {describe, expect, it} from 'vitest';
import {barSeconds, barTimes, beatSeconds, beatTimes, snapToBar} from './beatGrid';

describe('beat grid', () => {
  it('derives bar and beat lengths from the tempo', () => {
    expect(barSeconds(120)).toBe(2);
    expect(beatSeconds(120)).toBe(0.5);
    expect(barSeconds(60)).toBe(4);
    expect(barSeconds(90, 3)).toBe(2);
  });

  it('places bars every four beats across the film, starting at the soundtrack offset', () => {
    expect(barTimes(120, 0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(beatTimes(120, 0, 2)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(barTimes(120, 0.5, 10)).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
    expect(barTimes(60, 0, 10)).toEqual([0, 4, 8]);
  });

  it('keeps the grid anchored when the soundtrack starts before the film', () => {
    expect(barTimes(120, -1, 10)).toEqual([1, 3, 5, 7, 9]);
    expect(barTimes(120, -2, 4)).toEqual([0, 2, 4]);
    expect(beatTimes(120, -0.25, 1)).toEqual([0.25, 0.75]);
  });

  it('returns nothing for an unusable tempo, an offset past the film or an unreadably dense grid', () => {
    expect(barTimes(0, 0, 10)).toEqual([]);
    expect(barTimes(Number.NaN, 0, 10)).toEqual([]);
    expect(barTimes(120, 12, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(barTimes(120, 0, -1)).toEqual([]);
    expect(barTimes(300, 0, 36000)).toEqual([]);
    expect(beatTimes(120, 0, 0)).toEqual([0]);
  });

  it('snaps a film time to the nearest bar on the same grid', () => {
    expect(snapToBar(3.1, 120, 0)).toBe(4);
    expect(snapToBar(0.9, 120, 0)).toBe(0);
    expect(snapToBar(2.4, 120, 0.5)).toBe(2.5);
    expect(snapToBar(0.2, 120, -1)).toBe(1);
    expect(snapToBar(7.7, 0, 0)).toBe(7.7);
  });
});
