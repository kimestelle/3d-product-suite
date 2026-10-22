import {validateCamera} from './camera';
import {cameraBaseForSharedMotion, filmCameraPoseAtFrame, validateFilmMotions, type FilmMotion} from './filmMotion';

export type CameraMotionPreset = 'still' | 'orbit' | 'dolly';
export type CameraMotionSelection = CameraMotionPreset | 'custom';

function shotFor(scene: any, shotId: string) {
  const shot = scene.shots.find((item: any) => item.id === shotId);
  if (!shot) throw new Error('This scene is no longer in the film.');
  return shot;
}

/** A local camera owner masks the across-cuts owner, including a zero-distance hold. */
export function effectiveCameraMotion(scene: any, shotId: string): FilmMotion | undefined {
  const shot = shotFor(scene, shotId);
  return (shot.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera')
    ?? (scene.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
}

/** Uses the existing sampler's zero-distance orbit instead of a second hold mechanism. */
export function isCameraHoldMotion(motion: FilmMotion | undefined): boolean {
  return !!motion && motion.target === '$camera' && motion.kind === 'orbit' && motion.amount === 0;
}

export function cameraMotionSelection(scene: any, shotId: string): CameraMotionSelection {
  const shot = shotFor(scene, shotId), camera = shot.camera;
  const motion = effectiveCameraMotion(scene, shotId);
  const heldSource = camera.durationFrames === 1;
  const staticLens = heldSource || camera.from.focalLengthMm === camera.to.focalLengthMm;
  if (motion) return motion.amount === 0 ? staticLens ? 'still' : 'custom' : motion.kind as 'orbit' | 'dolly';
  const staticPose = heldSource || ['positionM', 'targetM'].every(key => camera.from[key].every((value: number, index: number) => value === camera.to[key][index]));
  return staticPose && staticLens ? 'still' : 'custom';
}

function nextMotionId(scene: any): string {
  const ids = new Set([...(scene.motions ?? []), ...scene.shots.flatMap((shot: any) => shot.motions ?? [])].map((motion: FilmMotion) => motion.id));
  let number = 1; while (ids.has(`motion-${number}`)) number++;
  return `motion-${number}`;
}

/** Explicit scene-local replacement. Reading or selecting an existing preset never normalizes imported work. */
export function setCameraMotionPreset(scene: any, shotId: string, preset: CameraMotionPreset, frame: number): string | null {
  if (!['still', 'orbit', 'dolly'].includes(preset)) throw new Error('Choose Still, Orbit or Push in.');
  if (!Number.isFinite(frame)) throw new Error('Choose a valid frame before changing camera movement.');
  const source = shotFor(scene, shotId), selection = cameraMotionSelection(scene, shotId);
  if (selection === preset && preset !== 'still') return effectiveCameraMotion(scene, shotId)!.id;
  if (selection === 'still' && preset === 'still' && source.camera.durationFrames === 1) return null;

  const draft = structuredClone(scene), shot = shotFor(draft, shotId);
  const editedFrame = Math.max(shot.startFrame, Math.min(shot.endFrame, frame));
  const pose = filmCameraPoseAtFrame(draft, shot, editedFrame);
  const local: FilmMotion | undefined = (shot.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
  const shared: FilmMotion | undefined = (draft.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
  let selectedId: string | null = null;

  if (preset === 'still') {
    // Preserve the authored curve and amount so it remains recoverable in the scene.
    if (local) local.enabled = false;
    if (shared) {
      (shot.motions ??= []).push({id: nextMotionId(draft), target: '$camera', kind: 'orbit', axis: 'y', amount: 0,
        startFrame: 1, durationFrames: Math.max(2, shot.endFrame - shot.startFrame + 1), easing: 'linear', enabled: true});
    }
    shot.camera.from = structuredClone(pose); shot.camera.to = structuredClone(pose);
    shot.camera.durationFrames = 1;
  } else {
    const distance = Math.hypot(...pose.positionM.map((value: number, index: number) => value - pose.targetM[index]));
    const autoFocus = shot.camera.depthOfField?.enabled && shot.camera.depthOfField.focusDistanceM === undefined;
    const minimum = autoFocus ? pose.focalLengthMm / 1000 : .00001;
    const amount = preset === 'orbit' ? 30 : Math.min(.05, Math.max(0, (distance - minimum) / 2));
    const motion: FilmMotion = local ? local : {
      id: nextMotionId(draft), target: '$camera', kind: preset, axis: 'y', amount,
      startFrame: 1, durationFrames: Math.max(2, Math.min(shot.endFrame - shot.startFrame + 1, Math.round(draft.render.fps * 2) + 1)),
      easing: 'ease', enabled: true,
    };
    Object.assign(motion, {kind: preset, axis: 'y', amount, enabled: true});
    if (!local) (shot.motions ??= []).push(motion);
    // Curves may already have nonzero progress here. Rebase against the final
    // owner so choosing a new movement keeps the currently composed image.
    const base = cameraBaseForSharedMotion({motions: [motion]}, editedFrame - shot.startFrame + 1, pose);
    shot.camera.from = structuredClone(base); shot.camera.to = structuredClone(base);
    delete shot.camera.durationFrames;
    selectedId = motion.id;
  }

  // Validate the finished owner and camera together: an intermediate removal
  // could expose an inherited move that is invalid for this scene's framing.
  validateCamera(shot.camera); validateFilmMotions(draft);
  source.camera = shot.camera;
  if (shot.motions !== undefined) source.motions = shot.motions;
  return selectedId;
}
