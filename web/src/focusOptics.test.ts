import {describe, expect, it} from 'vitest';
import {circleOfConfusionMm, circleOfConfusionRadiusPx, sampledDepthOfField, sparkApertureAngle} from './focusOptics';
import {filmGuideZoom} from './filmGuides';

describe('Physical camera focus', () => {
  it('keeps legacy cameras sharp and derives automatic focus from their actual target distance', () => {
    const camera = {positionM: [0, .3, .4], targetM: [0, 0, 0], focalLengthMm: 50};
    expect(sampledDepthOfField(camera)).toEqual({enabled: false, fStop: 2.8, focusDistanceM: .5});
    expect(sampledDepthOfField({...camera, depthOfField: {enabled: true, fStop: 4}})).toEqual({enabled: true, fStop: 4, focusDistanceM: .5});
    expect(sampledDepthOfField({...camera, depthOfField: {enabled: true, fStop: 2, focusDistanceM: .25}}).focusDistanceM).toBe(.25);
    expect(sampledDepthOfField({...camera, depthOfField: {enabled: true, focusDistanceM: .03}}).enabled).toBe(false);
  });
  it('has zero blur at focus, opposite near/far signs, and a finite far limit', () => {
    expect(circleOfConfusionMm(.5, 50, .5, 2.8)).toBe(0);
    expect(circleOfConfusionMm(.25, 50, .5, 2.8)).toBeLessThan(0);
    expect(circleOfConfusionMm(1, 50, .5, 2.8)).toBeGreaterThan(0);
    expect(circleOfConfusionMm(1e6, 50, .5, 2.8)).toBeCloseTo(1000 * .05 * .05 / (2.8 * (.5 - .05)), 5);
    expect(circleOfConfusionMm(1, 50, .5, 5.6)).toBe(circleOfConfusionMm(1, 50, .5, 2.8) / 2);
    expect(circleOfConfusionMm(1, 50, .05, 2.8)).toBe(0);
  });
  it('maps the 36mm vertical sensor to the exact displayed gate rather than the full overscan image', () => {
    const zoom = filmGuideZoom(1000, 620, 9 / 16), gateHeight = 620 * zoom;
    const coc = circleOfConfusionMm(.8, 50, .5, 2);
    expect(circleOfConfusionRadiusPx(.8, 50, .5, 2, gateHeight)).toBeCloseTo(Math.abs(coc) * gateHeight / 72);
    expect(circleOfConfusionRadiusPx(.8, 50, .5, 2, gateHeight * 2)).toBeCloseTo(circleOfConfusionRadiusPx(.8, 50, .5, 2, gateHeight) * 2);
  });
  it('gives Spark native covariance the same physical circle radius as mesh optics', () => {
    const f = 50, focus = .5, fStop = 2.8, height = 492;
    const focalPixels = f / 36 * height;
    for (const depth of [.2, .5, .8, 8]) {
      const nativeRadius = Math.abs((depth - focus) / depth) * focalPixels * Math.tan(sparkApertureAngle(f, focus, fStop) / 2);
      expect(nativeRadius).toBeCloseTo(circleOfConfusionRadiusPx(depth, f, focus, fStop, height));
    }
  });
});
