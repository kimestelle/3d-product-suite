import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {shotAtFrame} from './sequence';
import {filmPlayheadReducer, type FilmPlayheadState} from './useFilmPlayhead';

const at = (frame: number): FilmPlayheadState => ({frame, editingFrame: frame});

describe('Film playhead and edit selection', () => {
  it('plays across a cut while retaining the selected edit shot and frame', () => {
    const first = fixture.shots[0], second = fixture.shots[1];
    const selectedFrame = first.endFrame - 1;
    let state = at(selectedFrame);
    state = filmPlayheadReducer(state, {type: 'playback', frame: frame => frame + 1});
    state = filmPlayheadReducer(state, {type: 'playback', frame: frame => frame + 1});
    expect(state).toEqual({frame: second.startFrame, editingFrame: selectedFrame});
    expect(shotAtFrame(fixture, state.frame).id).toBe(second.id);
    expect(shotAtFrame(fixture, state.editingFrame).id).toBe(first.id);
  });

  it('makes a manual seek the selected edit frame even when the preview already shows it', () => {
    let state = filmPlayheadReducer(at(25), {type: 'playback', frame: 150});
    state = filmPlayheadReducer(state, {type: 'seek', frame: 150});
    expect(state).toEqual(at(150));
    state = filmPlayheadReducer(state, {type: 'playback', frame: 200});
    state = filmPlayheadReducer(state, {type: 'restore-editing'});
    expect(state).toEqual(at(150));
  });

  it('steps from the visible playback frame and makes the result the edit selection', () => {
    let state = filmPlayheadReducer(at(25), {type: 'playback', frame: 150});
    state = filmPlayheadReducer(state, {type: 'seek', frame: frame => frame - 1});
    expect(state).toEqual(at(149));
    state = filmPlayheadReducer(state, {type: 'seek', frame: frame => frame + 1});
    state = filmPlayheadReducer(state, {type: 'seek', frame: frame => frame + 1});
    expect(state).toEqual(at(151));
  });

  it('returns to the saved edit frame after playback loops to a different shot', () => {
    const editingFrame = fixture.shots[1].startFrame;
    const before = at(editingFrame);
    let state = filmPlayheadReducer(before, {type: 'playback', frame: fixture.shots.at(-1)!.endFrame});
    state = filmPlayheadReducer(state, {type: 'playback', frame: 1});
    expect(state).toEqual({frame: 1, editingFrame});
    state = filmPlayheadReducer(state, {type: 'restore-editing'});
    expect(state).toEqual(before);
    expect(before).toEqual(at(editingFrame));
  });

  it('resets both frames on project load so returning to edit cannot restore the prior project', () => {
    let state = filmPlayheadReducer(at(150), {type: 'playback', frame: 200});
    state = filmPlayheadReducer(state, {type: 'seek', frame: 1});
    state = filmPlayheadReducer(state, {type: 'playback', frame: 10});
    state = filmPlayheadReducer(state, {type: 'restore-editing'});
    expect(state).toEqual(at(1));
  });

  it('retains state identity when a seek, playback tick or restore changes neither frame', () => {
    const state = at(25);
    expect(filmPlayheadReducer(state, {type: 'seek', frame: frame => frame})).toBe(state);
    expect(filmPlayheadReducer(state, {type: 'playback', frame: 25})).toBe(state);
    expect(filmPlayheadReducer(state, {type: 'restore-editing'})).toBe(state);
  });
});
