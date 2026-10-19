import {describe, expect, it} from 'vitest';
import {editorEntranceClip, entranceReducer, entranceState, LOADING_RADIUS, type EntranceState} from './studioEntrance';

const start = () => entranceReducer(entranceState(), {type: 'start'});
const finishContraction = (state: EntranceState) => entranceReducer(state, {type: 'advance', phase: 'contracting', progress: 1});

describe('Studio entry handoff', () => {
  it('never opens before both the scene and contraction are complete, even on a cached load', () => {
    let state = start();
    state = entranceReducer(state, {type: 'ready', attempt: state.attempt});
    expect(state.phase).toBe('contracting');
    state = entranceReducer(state, {type: 'advance', phase: 'contracting', progress: .99});
    expect(state.phase).toBe('contracting');
    state = finishContraction(state);
    expect(state).toMatchObject({phase: 'expanding', progress: 0, ready: true});
    state = entranceReducer(state, {type: 'advance', phase: 'expanding', progress: 1});
    expect(state.phase).toBe('studio');
  });

  it('holds the circle for a slow scene and opens when the presented frame arrives', () => {
    const waiting = finishContraction(start());
    expect(waiting).toMatchObject({phase: 'waiting', ready: false});
    expect(entranceReducer(waiting, {type: 'advance', phase: 'expanding', progress: 1})).toBe(waiting);
    expect(entranceReducer(waiting, {type: 'ready', attempt: waiting.attempt})).toMatchObject({phase: 'expanding', progress: 0});
  });

  it('gives the same result whichever gate finishes first', () => {
    const first = start();
    const sceneFirst = finishContraction(entranceReducer(first, {type: 'ready', attempt: first.attempt}));
    const motionFirst = entranceReducer(finishContraction(first), {type: 'ready', attempt: first.attempt});
    expect(sceneFirst).toEqual(motionFirst);
  });

  it.each(['contracting', 'waiting'] as const)('holds a failed %s attempt closed and retries with a fresh editor', phase => {
    let state = start();
    if (phase === 'waiting') state = finishContraction(state);
    const failedAttempt = state.attempt;
    state = entranceReducer(state, {type: 'failed', attempt: failedAttempt, message: 'Scene unavailable'});
    state = entranceReducer(state, {type: 'ready', attempt: failedAttempt});
    expect(state.error).toBe('Scene unavailable');
    if (phase === 'contracting') state = finishContraction(state);
    expect(state.phase).toBe('waiting');
    state = entranceReducer(state, {type: 'retry'});
    expect(state).toMatchObject({phase: 'waiting', ready: false, error: '', attempt: failedAttempt + 1});
    expect(entranceReducer(state, {type: 'failed', attempt: failedAttempt, message: 'Old request'})).toBe(state);
    expect(entranceReducer(state, {type: 'ready', attempt: failedAttempt})).toBe(state);
    expect(entranceReducer(state, {type: 'ready', attempt: state.attempt}).phase).toBe('expanding');
  });

  it('accepts retry during contraction without restarting or jumping the shape', () => {
    let state = entranceReducer(start(), {type: 'advance', phase: 'contracting', progress: .4});
    const failedAttempt = state.attempt;
    state = entranceReducer(state, {type: 'failed', attempt: failedAttempt, message: 'Connection failed'});
    state = entranceReducer(state, {type: 'retry'});
    expect(state).toMatchObject({phase: 'contracting', progress: .4, error: '', ready: false, attempt: failedAttempt + 1});
    expect(entranceReducer(state, {type: 'ready', attempt: failedAttempt})).toBe(state);
    state = entranceReducer(state, {type: 'ready', attempt: state.attempt});
    expect(state.phase).toBe('contracting');
    expect(finishContraction(state).phase).toBe('expanding');
  });

  it('does not revive an abandoned entry when old renderer callbacks finish', () => {
    const abandoned = start();
    const returned = entranceReducer(abandoned, {type: 'back'});
    const later = entranceReducer(returned, {type: 'start'});
    for (const state of [returned, later]) {
      expect(entranceReducer(state, {type: 'ready', attempt: abandoned.attempt})).toBe(state);
      expect(entranceReducer(state, {type: 'failed', attempt: abandoned.attempt, message: 'Disposed scene'})).toBe(state);
    }
    expect(returned.phase).toBe('landing');
    expect(later.attempt).toBeGreaterThan(abandoned.attempt);
  });

  it('ignores duplicate starts and stale callbacks after the editor is open', () => {
    const loading = start();
    expect(entranceReducer(loading, {type: 'start'})).toBe(loading);
    const opened = entranceReducer(entranceReducer(finishContraction(loading), {type: 'ready', attempt: loading.attempt}), {type: 'advance', phase: 'expanding', progress: 1});
    expect(entranceReducer(opened, {type: 'ready', attempt: opened.attempt})).toBe(opened);
    expect(entranceReducer(opened, {type: 'failed', attempt: opened.attempt, message: 'Late failure'})).toBe(opened);
  });

  it('never rewinds motion or lets a callback from a different phase complete it', () => {
    let state = entranceReducer(start(), {type: 'advance', phase: 'contracting', progress: .8});
    state = entranceReducer(state, {type: 'advance', phase: 'contracting', progress: .2});
    expect(state.progress).toBe(.8);
    expect(entranceReducer(state, {type: 'advance', phase: 'expanding', progress: 1})).toBe(state);
  });

  it('can skip motion for reduced motion without skipping actual renderer readiness', () => {
    const waiting = finishContraction(start());
    expect(waiting.phase).toBe('waiting');
    const ready = entranceReducer(waiting, {type: 'ready', attempt: waiting.attempt});
    expect(entranceReducer(ready, {type: 'advance', phase: 'expanding', progress: 1}).phase).toBe('studio');
  });

  it('shows direct editor routes without requiring the landing transition', () => {
    expect(entranceState(false).phase).toBe('studio');
    expect(entranceReducer(entranceState(), {type: 'direct'})).toMatchObject({phase: 'studio', attempt: 1});
  });
});

describe('Editor aperture geometry', () => {
  const origin = {x: 700, y: 400, width: 940, viewportWidth: 1440, viewportHeight: 900, aperture: 1};
  const numbers = (value: string) => value.match(/-?\d+(?:\.\d+)?/g)!.map(Number);

  it('begins at the exact loading circle without resizing the editor underneath it', () => {
    const [top, right, bottom, left, radius] = numbers(editorEntranceClip(origin, 0));
    expect(origin.viewportWidth - right - left).toBe(LOADING_RADIUS * 2);
    expect(origin.viewportHeight - top - bottom).toBe(LOADING_RADIUS * 2);
    expect(left + radius).toBe(origin.x);
    expect(top + radius).toBe(origin.y);
    expect(radius).toBe(LOADING_RADIUS);
  });

  it('fully removes the clipping inset at completion', () => {
    expect(numbers(editorEntranceClip(origin, 1))).toEqual([0, 0, 0, 0, 0]);
    expect(editorEntranceClip(origin, 2)).toBe(editorEntranceClip(origin, 1));
    expect(editorEntranceClip(origin, -1)).toBe(editorEntranceClip(origin, 0));
  });

  it('expands every edge monotonically while retaining one rounded perimeter', () => {
    let previous = numbers(editorEntranceClip(origin, 0));
    for (const progress of [.1, .25, .5, .75, .9, 1]) {
      const current = numbers(editorEntranceClip(origin, progress));
      current.forEach((value, index) => {expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(previous[index]);});
      previous = current;
    }
  });
});
