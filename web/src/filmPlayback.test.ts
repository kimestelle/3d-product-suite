import {describe, expect, it} from 'vitest';
import {resolveFilmPlaybackFrame} from './filmPlayback';

describe('Film preview playback range', () => {
  it.each([false, true])('keeps both endpoints visible with loop=%s', loop => {
    expect(resolveFilmPlaybackFrame(25, 25, 48, loop)).toEqual({frame: 25, ended: false, wrapped: false});
    expect(resolveFilmPlaybackFrame(36, 25, 48, loop)).toEqual({frame: 36, ended: false, wrapped: false});
    expect(resolveFilmPlaybackFrame(48, 25, 48, loop)).toEqual({frame: 48, ended: false, wrapped: false});
  });

  it.each([false, true])('clamps a tick before the playback range without ending it, loop=%s', loop => {
    expect(resolveFilmPlaybackFrame(1, 25, 48, loop)).toEqual({frame: 25, ended: false, wrapped: false});
    expect(resolveFilmPlaybackFrame(-10, 25, 48, loop)).toEqual({frame: 25, ended: false, wrapped: false});
  });

  it.each([49, 65, 500])('stops on the final frame when a non-looping tick reaches %s', nextFrame => {
    expect(resolveFilmPlaybackFrame(nextFrame, 25, 48, false)).toEqual({frame: 48, ended: true, wrapped: false});
  });

  it('wraps immediately after the last frame, including an offset scene range', () => {
    expect(resolveFilmPlaybackFrame(241, 1, 240, true)).toEqual({frame: 1, ended: false, wrapped: true});
    expect(resolveFilmPlaybackFrame(49, 25, 48, true)).toEqual({frame: 25, ended: false, wrapped: true});
  });

  it('preserves overshoot when a delayed tick crosses one or several laps', () => {
    expect(resolveFilmPlaybackFrame(54, 25, 48, true)).toEqual({frame: 30, ended: false, wrapped: true});
    expect(resolveFilmPlaybackFrame(25 + 24 * 5 + 7, 25, 48, true)).toEqual({frame: 32, ended: false, wrapped: true});
    expect(resolveFilmPlaybackFrame(25 + 24 * 5 - 1, 25, 48, true)).toEqual({frame: 48, ended: false, wrapped: true});
  });

  it('supports a single-frame scene without an empty or zero-length loop', () => {
    expect(resolveFilmPlaybackFrame(12, 12, 12, true)).toEqual({frame: 12, ended: false, wrapped: false});
    expect(resolveFilmPlaybackFrame(13, 12, 12, true)).toEqual({frame: 12, ended: false, wrapped: true});
    expect(resolveFilmPlaybackFrame(13, 12, 12, false)).toEqual({frame: 12, ended: true, wrapped: false});
  });

  it.each([
    [1, 0, 24],
    [1, 24, 1],
    [1.5, 1, 24],
    [1, 1.5, 24],
    [1, 1, 24.5],
    [NaN, 1, 24],
    [Infinity, 1, 24],
    [1, 1, Infinity],
    [Number.MAX_SAFE_INTEGER + 1, 1, 24],
  ])('rejects an invalid tick/range (%s, %s, %s)', (nextFrame, startFrame, endFrame) => {
    expect(() => resolveFilmPlaybackFrame(nextFrame, startFrame, endFrame, true)).toThrow(RangeError);
  });
});
