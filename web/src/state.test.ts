import { describe, expect, it } from 'vitest';
import {
  canRedo, canUndo, commitHistory, createHistory, redoHistory, undoHistory,
} from './state';

const scene = () => ({
  product: { label: 'MORA', color: [0.13, 0.24, 0.18] },
  action: { start: 5.4, duration: 3 },
});

describe('scene document history', () => {
  it('restores label, color and timing together through undo and redo', () => {
    const original = scene();
    const changed = scene();
    changed.product.label = 'NOVA';
    changed.product.color = [0.2, 0.1, 0.1];
    changed.action.duration = 4;
    const first = createHistory(original);
    const edited = commitHistory(first, changed);
    expect(canUndo(edited)).toBe(true);
    expect(canRedo(edited)).toBe(false);
    const undone = undoHistory(edited);
    expect(undone.present).toEqual(original);
    expect(canRedo(undone)).toBe(true);
    expect(redoHistory(undone).present).toEqual(changed);
    expect(first.present).toEqual(original);
  });

  it('isolates snapshots from later caller mutations', () => {
    const input = scene();
    const first = createHistory(input);
    input.product.label = 'accidental mutation';
    expect(first.present.product.label).toBe('MORA');
    const next = scene();
    next.action.start = 6;
    const edited = commitHistory(first, next);
    next.action.start = 999;
    expect(edited.present.action.start).toBe(6);
    edited.present.product.color[0] = 1;
    expect(edited.past[0].product.color[0]).toBe(0.13);
  });

  it('clears redo when an alternate edit follows undo', () => {
    let history = createHistory({ label: 'A' });
    history = commitHistory(history, { label: 'B' });
    history = commitHistory(history, { label: 'C' });
    history = undoHistory(history);
    expect(history.present.label).toBe('B');
    history = commitHistory(history, { label: 'D' });
    expect(canRedo(history)).toBe(false);
    expect(undoHistory(history).present.label).toBe('B');
  });

  it('does not add a history entry for a scene with no changed values', () => {
    const history = createHistory(scene());
    expect(commitHistory(history, scene())).toBe(history);
    expect(undoHistory(history)).toBe(history);
    expect(redoHistory(history)).toBe(history);
  });

  it('keeps only the requested number of past snapshots', () => {
    let history = createHistory({ frame: 1 });
    for (let frame = 2; frame <= 6; frame += 1) {
      history = commitHistory(history, { frame }, 3);
    }
    expect(history.past.map((value) => value.frame)).toEqual([3, 4, 5]);
    for (let index = 0; index < 3; index += 1) history = undoHistory(history);
    expect(history.present.frame).toBe(3);
    expect(canUndo(history)).toBe(false);
    expect(() => commitHistory(history, { frame: 7 }, 0)).toThrow(RangeError);
  });

  it('preserves every intermediate edit during repeated backward/forward navigation', () => {
    let history = createHistory({ value: 0 });
    for (let value = 1; value <= 10; value += 1) {
      history = commitHistory(history, { value });
    }
    for (let value = 9; value >= 0; value -= 1) {
      history = undoHistory(history);
      expect(history.present.value).toBe(value);
    }
    for (let value = 1; value <= 10; value += 1) {
      history = redoHistory(history);
      expect(history.present.value).toBe(value);
    }
  });
});

import { equalJson } from './state';
it('ignores server key ordering without ignoring array order or values',()=>{expect(equalJson({product:{name:'a'},editorHierarchy:{version:1}},{editorHierarchy:{version:1},product:{name:'a'}})).toBe(true);expect(equalJson([1,2],[2,1])).toBe(false);expect(equalJson({a:1},{a:2})).toBe(false);expect(equalJson({a:null},{})).toBe(false)});
