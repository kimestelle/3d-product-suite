import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearCache, prepare} from '@chenglou/pretext';
import {measureFlowText, type PreparedFlowBlock, type TextMeasure} from './philosophyText';

let canvasMeasurements = 0;

// Exercise Pretext's real preparation and line breaker. Only font metrics are
// deterministic here; browser QA supplies the real Halyard font measurements.
class TestCanvas {
  getContext() {
    return {
      font: '16px sans-serif',
      letterSpacing: '0px',
      measureText(text: string) {
        canvasMeasurements++;
        const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16);
        const width = [...text].length * size / 2;
        return {width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width};
      },
    };
  }
}

const text = (value: string, overrides: Partial<TextMeasure> = {}): TextMeasure => ({
  prepared: prepare(value, '400 16px "Halyard Text"'),
  lineHeight: 24, left: 0, top: 0, width: 220, naturalHeight: 24,
  ...overrides,
});

beforeAll(() => vi.stubGlobal('OffscreenCanvas', TestCanvas));
beforeEach(() => {clearCache(); canvasMeasurements = 0;});
afterAll(() => {clearCache(); vi.unstubAllGlobals();});

describe('prepared Shape + Light text flow', () => {
  it('preserves measured natural heights and structural gaps across mixed typography', () => {
    const block: PreparedFlowBlock = {
      height: 216,
      texts: [
        text('01 / result', {prepared: prepare('01 / result', '400 12px "Halyard Text"'), lineHeight: 18, top: 8, naturalHeight: 18}),
        // The real DOM may reserve more height than greedy text measurement,
        // for example a balanced title. Its measured baseline stays intact.
        text('One frame', {prepared: prepare('One frame', '500 40px "Halyard Display"'), lineHeight: 48, top: 44, naturalHeight: 64}),
        text('alpha beta gamma delta', {top: 140}),
        text('last', {top: 180}),
      ],
    };

    const natural = measureFlowText(block, 220);
    expect(natural.height).toBe(216);
    expect(natural.lines.map(line => line.top)).toEqual([8, 44, 140, 180]);

    const narrow = measureFlowText(block, 110);
    expect(narrow.height).toBe(288);
    expect(narrow.lines.map(line => line.top)).toEqual([8, 44, 92, 188, 212, 252]);
    expect(narrow.lines.map(line => line.height)).toEqual([18, 48, 48, 24, 24, 24]);
    // The second paragraph retains its original 16px gap after the first.
    expect(narrow.lines[5].top - (narrow.lines[4].top + narrow.lines[4].height)).toBe(16);
    expect(block.height).toBe(216);
    expect(block.texts.map(leaf => leaf.top)).toEqual([8, 44, 140, 180]);
  });

  it('keeps explicit heading breaks even when the available width grows', () => {
    const block: PreparedFlowBlock = {height: 115, texts: [text('unused', {
      prepared: prepare('How we\nmake things.', '500 40px "Halyard Display"', {whiteSpace: 'pre-wrap'}),
      top: 7, width: 400, lineHeight: 48, naturalHeight: 96,
    })]};
    const result = measureFlowText(block, 800);
    expect(result.height).toBe(115);
    expect(result.lines.map(line => ({top: line.top, height: line.height}))).toEqual([
      {top: 7, height: 48}, {top: 55, height: 48},
    ]);
  });

  it('respects each leaf width cap and subtracts its inset from the available lane', () => {
    const block: PreparedFlowBlock = {height: 80, texts: [text('alpha beta gamma delta', {
      left: 24, top: 4, width: 80, naturalHeight: 72,
    })]};
    const wide = measureFlowText(block, 400);
    expect(wide.height).toBe(80);
    expect(wide.lines).toHaveLength(3);
    expect(wide.lines.map(line => line.width)).toEqual([80, 40, 40]);
    expect(wide.lines.every(line => line.left === 24)).toBe(true);

    const narrow = measureFlowText(block, 100);
    expect(narrow.height).toBe(104);
    expect(narrow.lines).toHaveLength(4);
    expect(narrow.lines.every(line => line.left + line.width <= 100)).toBe(true);
  });

  it('reflows cached preparations without further Canvas measurements', () => {
    const block: PreparedFlowBlock = {height: 24, texts: [text('A campaign is made in revisions.')]};
    const preparedCalls = canvasMeasurements;
    expect(preparedCalls).toBeGreaterThan(0);
    for(let i = 0; i < 50; i++) measureFlowText(block, 80 + i * 4);
    expect(canvasMeasurements).toBe(preparedCalls);
  });

  it('returns finite line bands when the lane is zero or smaller than a text inset', () => {
    const block: PreparedFlowBlock = {height: 30, texts: [text('abc', {left: 24, top: 6})]};
    for(const width of [0, 1, 12, 24]) {
      const result = measureFlowText(block, width);
      expect(Number.isFinite(result.height)).toBe(true);
      expect(result.height).toBeGreaterThanOrEqual(30);
      expect(result.lines).toHaveLength(3);
      for(const line of result.lines) {
        expect(Object.values(line).every(Number.isFinite)).toBe(true);
        expect(line.height).toBeGreaterThan(0);
        expect(line.width).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('restores exactly the same layout when scrolling back through prior widths', () => {
    const block: PreparedFlowBlock = {height: 84, texts: [
      text('Keep what has been decided.', {naturalHeight: 48}),
      text('The next version.', {top: 64}),
    ]};
    const widths = [220, 180, 140, 100, 60];
    const forward = widths.map(width => measureFlowText(block, width));
    const reverse = [...widths].reverse().map(width => measureFlowText(block, width)).reverse();
    expect(reverse).toEqual(forward);
    expect(measureFlowText(block, 220).height).toBe(84);
  });
});
