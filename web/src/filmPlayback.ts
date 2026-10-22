export interface FilmPlaybackFrame {
  frame: number;
  ended: boolean;
  wrapped: boolean;
}

/** Resolve a forward preview tick against an inclusive film or scene range. */
export function resolveFilmPlaybackFrame(nextFrame: number, startFrame: number, endFrame: number, loop: boolean): FilmPlaybackFrame {
  if (![nextFrame, startFrame, endFrame].every(Number.isSafeInteger) || startFrame < 1 || endFrame < startFrame) {
    throw new RangeError('Film playback requires integer frames and a valid positive frame range.');
  }
  // The last frame remains visible for its full frame interval; only the next tick ends or loops.
  if (nextFrame <= endFrame) return {frame: Math.max(startFrame, nextFrame), ended: false, wrapped: false};
  if (!loop) return {frame: endFrame, ended: true, wrapped: false};
  const length = endFrame - startFrame + 1;
  return {frame: startFrame + (nextFrame - startFrame) % length, ended: false, wrapped: true};
}
