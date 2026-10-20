import {type MotionEntry, type FilmMotion} from './filmMotion';
import {sequenceEnd, shotFrames, type Shot} from './sequence';
import {clamp, motionBounds} from './FilmWorkspaceShared';

/** The selected target stays on one film clock even while playback crosses a cut. */
export function timelineMotions(scene: any, target: string): MotionEntry[] {
  return [...scene.shots.flatMap((shot: Shot) => (shot.motions ?? []).filter((motion: FilmMotion) => motion.target === target)
    .map((motion: FilmMotion) => ({motion, scope: 'shot' as const, shotId: shot.id}))),
  ...(scene.motions ?? []).filter((motion: FilmMotion) => motion.target === target).map((motion: FilmMotion) => ({motion, scope: 'film' as const}))];
}

export function timelineMotionBounds(scene: any, entry: MotionEntry) {
  const owner: Shot | undefined = entry.scope === 'shot' ? scene.shots.find((shot: Shot) => shot.id === entry.shotId) : undefined;
  const bounds = motionBounds(entry, owner), total = sequenceEnd(scene);
  const start = Math.max(bounds.start, owner?.startFrame ?? 1), end = Math.min(bounds.end, owner?.endFrame ?? total);
  return {start, end, visible: end >= start, clipped: start !== bounds.start || end !== bounds.end,
    left: (start - 1) / total * 100, width: Math.max(0, end - start + 1) / total * 100};
}

export function motionStartAfterDrag(start: number, deltaX: number, laneWidth: number, total: number, maximum: number) {
  return clamp(start + Math.round(deltaX / Math.max(1, laneWidth) * total), 1, maximum);
}

export function motionStartMaximum(scene: any, entry: MotionEntry) {
  const owner = scene.shots.find((shot: Shot) => shot.id === entry.shotId);
  return Math.max(1, (entry.scope === 'film' ? sequenceEnd(scene) : shotFrames(owner)) - entry.motion.durationFrames + 1);
}

/** Trim changes the scene boundary; it never silently retimes its authored action. */
export function sceneFramesAfterTrim(frames: number, deltaX: number, laneWidth: number, total: number) {
  return Math.max(1, frames + Math.round(deltaX / Math.max(1, laneWidth) * total));
}
