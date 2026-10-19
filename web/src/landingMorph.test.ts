import {describe, expect, it} from 'vitest';
import {clampLandingProgress, landingMorphPath} from './landingMorph';

type Point = {x: number; y: number};

function sample(path: string, divisions = 12): Point[] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  let start = {x: numbers[0], y: numbers[1]};
  const result: Point[] = [];
  for (let index = 2; index < numbers.length; index += 6) {
    const a = {x: numbers[index], y: numbers[index + 1]}, b = {x: numbers[index + 2], y: numbers[index + 3]}, end = {x: numbers[index + 4], y: numbers[index + 5]};
    for (let part = 0; part < divisions; part++) {
      const t = part / divisions, u = 1 - t;
      result.push({x: u ** 3 * start.x + 3 * u ** 2 * t * a.x + 3 * u * t ** 2 * b.x + t ** 3 * end.x, y: u ** 3 * start.y + 3 * u ** 2 * t * a.y + 3 * u * t ** 2 * b.y + t ** 3 * end.y});
    }
    start = end;
  }
  return result;
}

function bounds(points: Point[]) {
  return {left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)), top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y))};
}

describe('Landing window morph', () => {
  it('starts with four diagonal arms, rounded extremities, and a center wide enough for the wordmark', () => {
    const points = sample(landingMorphPath(0)), box = bounds(points);
    expect(box.left).toBeCloseTo(210, 0); expect(box.right).toBeCloseTo(790, 0);
    expect(box.top).toBeCloseTo(30, 0); expect(box.bottom).toBeCloseTo(570, 0);
    const center = points[0], diagonal = points[96];
    expect(center.x - 500).toBeGreaterThan(135);
    expect(Math.hypot(diagonal.x - 500, diagonal.y - 300)).toBeGreaterThan(center.x - 500 + 100);
  });

  it('passes through a circular aperture with no lobes', () => {
    for (const point of sample(landingMorphPath(.5))) expect(Math.hypot(point.x - 500, point.y - 300)).toBeCloseTo(260, 2);
    expect(bounds(sample(landingMorphPath(.5)))).toEqual({left: 240, right: 760, top: 40, bottom: 560});
  });

  it('ends as a broad rectangle with straight edges and 95-unit rounded corners', () => {
    const points = sample(landingMorphPath(1)), box = bounds(points);
    expect(box.left).toBeCloseTo(32, 6); expect(box.right).toBeCloseTo(968, 6);
    expect(box.top).toBeCloseTo(30, 6); expect(box.bottom).toBeCloseTo(570, 6);
    // Points well into a corner must follow its radius rather than a superellipse.
    const corner = points.filter(point => point.x > 900 && point.y > 505);
    expect(corner.length).toBeGreaterThan(2);
    for (const point of corner) expect(Math.abs(Math.hypot(point.x - 873, point.y - 475) - 95)).toBeLessThan(1);
  });

  it.each([0, .1, .25, .4, .5, .6, .75, .9, 1])('keeps one closed, symmetric, non-self-intersecting perimeter at %s', progress => {
    const path = landingMorphPath(progress), points = sample(path);
    expect(path.match(/C/g)).toHaveLength(64); expect(path.endsWith(' Z')).toBe(true);
    for (let index = 0; index < points.length; index++) {
      const point = points[index], next = points[(index + 1) % points.length], opposite = points[(index + points.length / 2) % points.length];
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      // Every small step advances around the center: the boundary cannot fold or cross itself.
      expect((point.x - 500) * (next.y - 300) - (point.y - 300) * (next.x - 500)).toBeGreaterThan(0);
      expect(point.x + opposite.x).toBeCloseTo(1000, 2); expect(point.y + opposite.y).toBeCloseTo(600, 2);
    }
  });

  it('clamps out-of-range input and safely recovers from an invalid pointer calculation', () => {
    expect(clampLandingProgress(NaN)).toBe(0);
    expect(landingMorphPath(-1)).toBe(landingMorphPath(0));
    expect(landingMorphPath(-Infinity)).toBe(landingMorphPath(0));
    expect(landingMorphPath(NaN)).toBe(landingMorphPath(0));
    expect(landingMorphPath(2)).toBe(landingMorphPath(1));
    expect(landingMorphPath(Infinity)).toBe(landingMorphPath(1));
  });
});
