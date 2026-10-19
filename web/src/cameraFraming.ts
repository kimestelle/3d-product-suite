import {type CameraPose} from './camera';

/** A source camera may finish before, or extend beyond, the editorial shot. */
export function cameraSourceEndFrame(shot: any): number {
  return shot.startFrame + (shot.camera.durationFrames ?? shot.endFrame - shot.startFrame + 1) - 1;
}

/** UI projection of the shared scene sampler's eased camera path. */
export function cameraPoseAtFrame(shot: any, frame: number): CameraPose {
  const duration = shot.camera.durationFrames ?? shot.endFrame - shot.startFrame + 1;
  const t = duration === 1 ? 0 : Math.max(0, Math.min(1, (frame - shot.startFrame) / Math.max(1, duration - 1)));
  const u = t * t * (3 - 2 * t);
  const from = shot.camera.from as CameraPose, to = shot.camera.to as CameraPose;
  return {
    positionM: from.positionM.map((value, index) => value + (to.positionM[index] - value) * u),
    targetM: from.targetM.map((value, index) => value + (to.targetM[index] - value) * u),
    focalLengthMm: from.focalLengthMm + (to.focalLengthMm - from.focalLengthMm) * u,
  };
}

/** Reframe a still without erasing the video path: carry each edited value's delta to both ends. */
export function offsetCameraFraming(camera: {from: CameraPose; to: CameraPose}, pose: CameraPose, edit: (next: CameraPose) => void) {
  const next = structuredClone(pose);
  edit(next);
  for (const end of [camera.from, camera.to]) {
    for (const key of ['positionM', 'targetM'] as const) {
      end[key] = end[key].map((value, index) => value + next[key][index] - pose[key][index]);
    }
    end.focalLengthMm += next.focalLengthMm - pose.focalLengthMm;
  }
}
