import {cameraPoseAtFrame} from './cameraFraming';
import type {CameraPose} from './camera';

/** Authored Film actions. Frames are one-based; duration includes both samples. */
export type MotionKind = 'move' | 'rotate' | 'scale' | 'mechanical' | 'orbit' | 'dolly';
export type MotionScope = 'shot' | 'film';
export type MotionEasing = 'linear' | 'ease' | 'hold';
export type FilmMotionKey = {frame: number; value: number; interpolation: MotionEasing};
export type FilmMotion = {id: string; target: string; kind: MotionKind; axis: 'x' | 'y' | 'z'; amount: number;
  startFrame: number; durationFrames: number; easing: MotionEasing; enabled: boolean; keys?: FilmMotionKey[]};
export type MotionEntry = {motion: FilmMotion; scope: MotionScope; shotId?: string};

const kinds: MotionKind[] = ['move', 'rotate', 'scale', 'mechanical', 'orbit', 'dolly'];
const easings: MotionEasing[] = ['linear', 'ease', 'hold'];
const fail = (condition: unknown, message: string) => {if (!condition) throw new Error(message);};
const whole = (value: number, label: string) => fail(Number.isSafeInteger(value) && value >= 1, `${label} must be a positive whole number.`);
const findShot = (scene: any, shotId: string) => {
  const shot = scene.shots.find((item: any) => item.id === shotId);
  if (!shot) throw new Error('This shot is no longer in the film.');
  return shot;
};

export function motionLabel(motion: Pick<FilmMotion, 'kind'>): string {
  return ({move: 'Move', rotate: 'Rotate', scale: 'Scale', mechanical: 'Mechanism', orbit: 'Orbit', dolly: 'Dolly'})[motion.kind];
}

export function availableMotionKinds(scene: any, target: string): MotionKind[] {
  if (target === '$camera') return ['orbit', 'dolly'];
  if (target === '$product') return ['move', 'rotate', 'scale'];
  if (!scene.product.components.some((part: any) => part.id === target)) return [];
  // The current evaluator cannot move an assembly reference independently.
  if (scene.actions.some((action: any) => action.relativeTo === target)) return [];
  const confirmed = scene.actions.some((action: any) => action.componentId === target && action.approval === 'confirmed');
  return confirmed ? ['mechanical', 'move', 'rotate', 'scale'] : ['move', 'rotate', 'scale'];
}

/** Camera actions own the complete camera position; independent spatial owners cannot compete. */
export function motionChannels(motion: Pick<FilmMotion, 'kind' | 'axis'>): string[] {
  if (motion.kind === 'orbit' || motion.kind === 'dolly') return ['camera.position'];
  if (motion.kind === 'mechanical') return ['motion', ...['x', 'y', 'z'].flatMap(axis => [`position.${axis}`, `rotation.${axis}`])];
  return motion.kind === 'scale' ? ['scale'] : [`${motion.kind === 'move' ? 'position' : 'rotation'}.${motion.axis}`];
}

export function listMotions(scene: any, shotId: string): MotionEntry[] {
  const shot = findShot(scene, shotId);
  return [...(shot.motions ?? []).map((motion: FilmMotion) => ({motion, scope: 'shot' as const, shotId})),
    ...(scene.motions ?? []).map((motion: FilmMotion) => ({motion, scope: 'film' as const}))];
}

export function validateFilmMotions(scene: any): void {
  fail(!scene.product.components.some((part: any) => part.id === '$camera' || part.id === '$product'), 'Reserved animation target ID.');
  for (const source of [scene, ...scene.shots]) {
    if (source.motions === undefined) continue;
    fail(Array.isArray(source.motions), 'Motions must be a list.');
    const ids = new Set<string>(), owners = new Set<string>();
    for (const motion of source.motions as FilmMotion[]) {
      fail(motion && typeof motion === 'object', 'Motion must be an object.');
      fail(typeof motion.id === 'string' && motion.id.trim().length > 0 && motion.id.length <= 120 && !ids.has(motion.id), 'Motion IDs must be unique within their scope.');
      ids.add(motion.id);
      fail(kinds.includes(motion.kind) && availableMotionKinds(scene, motion.target).includes(motion.kind), 'This action is unavailable for the selected object.');
      fail(['x', 'y', 'z'].includes(motion.axis), 'Choose an X, Y or Z axis.');
      // Vertical-axis orbits preserve the renderer’s Y-up camera convention.
      fail(motion.kind !== 'orbit' || motion.axis === 'y', 'Orbit uses the vertical Y axis. Use framing for elevation.');
      fail(Number.isFinite(motion.amount), 'Motion amount must be finite.');
      if (motion.kind === 'scale') fail(motion.amount >= .01 && motion.amount <= 100, 'Scale must be between 0.01× and 100×.');
      if (motion.kind === 'mechanical') fail(motion.amount >= 0 && motion.amount <= 1, 'Mechanism progress must be between 0% and 100%.');
      whole(motion.startFrame, 'Motion start'); whole(motion.durationFrames, 'Motion duration');
      fail(motion.durationFrames >= 2, 'A motion needs at least two frames.');
      fail(easings.includes(motion.easing), 'Choose linear, ease or hold timing.');
      fail(typeof motion.enabled === 'boolean', 'Motion enabled must be true or false.');
      if (motion.keys !== undefined) {
        fail(Array.isArray(motion.keys) && motion.keys.length > 0, 'A custom curve needs at least one key.');
        let previous = 0;
        for (const key of motion.keys) {
          whole(key.frame, 'Key frame');
          fail(key.frame > previous && key.frame <= motion.durationFrames, 'Curve keys must be ordered, distinct and inside the motion.');
          fail(Number.isFinite(key.value) && key.value >= 0 && key.value <= 1, 'Curve progress must stay between 0% and 100%.');
          fail(easings.includes(key.interpolation), 'Curve interpolation is unsupported.');
          previous = key.frame;
        }
      }
      if (motion.enabled) for (const channel of motionChannels(motion)) {
        const owner = `${motion.target}/${channel}`;
        fail(!owners.has(owner), `This object already has a motion controlling ${channel}. Edit or disable that motion first.`);
        owners.add(owner);
      }
    }
  }
  for (const shot of scene.shots) {
    if (shot.camera.durationFrames !== undefined) whole(shot.camera.durationFrames, 'Camera source duration');
    const sharedIds = new Set((scene.motions ?? []).map((motion: FilmMotion) => motion.id));
    fail(!(shot.motions ?? []).some((motion: FilmMotion) => sharedIds.has(motion.id)), 'Local and across-cuts motions need distinct IDs in the same shot.');
    const local = (shot.motions ?? []).filter((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
    const motion = local[0] ?? (scene.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
    if (motion?.kind === 'dolly' || motion?.kind === 'orbit') {
      const camera = shot.camera;
      const distance = Math.hypot(...camera.from.positionM.map((value: number, index: number) => value - camera.from.targetM[index]));
      const autoFocus = camera.depthOfField?.enabled && camera.depthOfField.focusDistanceM === undefined;
      const minimum = autoFocus ? Math.max(camera.from.focalLengthMm, camera.to.focalLengthMm) / 1000 : .00001;
      const remaining = distance - (motion.kind === 'dolly' ? Math.max(0, motion.amount) : 0);
      fail(remaining > minimum, 'Camera motion must stop before its target and focus plane.');
    }
  }
}

function edit(scene: any, callback: (draft: any) => void) {
  const draft = structuredClone(scene);
  callback(draft); validateFilmMotions(draft);
  if (draft.motions !== undefined) scene.motions = draft.motions;
  for (let index = 0; index < scene.shots.length; index++) {
    if (draft.shots[index].motions !== undefined) scene.shots[index].motions = draft.shots[index].motions;
  }
}

function entry(scene: any, shotId: string, id: string): MotionEntry {
  const result = listMotions(scene, shotId).find(item => item.motion.id === id);
  if (!result) throw new Error('This motion is no longer in the selected shot.');
  return result;
}

export function addMotion(scene: any, shotId: string, target: string, kind: MotionKind): string {
  const ids = new Set([...(scene.motions ?? []), ...scene.shots.flatMap((shot: any) => shot.motions ?? [])].map((motion: FilmMotion) => motion.id));
  let index = 1; while (ids.has(`motion-${index}`)) index++;
  const id = `motion-${index}`;
  edit(scene, draft => {
    const shot = findShot(draft, shotId);
    const amount = {move: .05, rotate: 30, scale: 1.15, mechanical: 1, orbit: 30, dolly: .05}[kind];
    const motion: FilmMotion = {id, target, kind, axis: 'y', amount, startFrame: 1,
      durationFrames: Math.max(2, Math.min(shot.endFrame - shot.startFrame + 1, Math.round(draft.render.fps * 2) + 1)), easing: 'ease', enabled: true};
    (shot.motions ??= []).push(motion);
  });
  return id;
}

export function updateMotion(scene: any, shotId: string, id: string, patch: Partial<Omit<FilmMotion, 'id'>>) {
  edit(scene, draft => {
    const motion = entry(draft, shotId, id).motion;
    if (patch.durationFrames !== undefined && patch.durationFrames !== motion.durationFrames && !('keys' in patch)) {
      whole(patch.durationFrames, 'Motion duration');
      fail(patch.durationFrames >= 2, 'A motion needs at least two frames.');
      const retimed = retimeMotions([motion], (patch.durationFrames - 1) / (motion.durationFrames - 1))![0];
      if (retimed.keys) motion.keys = retimed.keys;
    }
    Object.assign(motion, patch);
  });
}

export function removeMotion(scene: any, shotId: string, id: string) {
  edit(scene, draft => {
    const item = entry(draft, shotId, id);
    const source = item.scope === 'film' ? draft : findShot(draft, shotId);
    source.motions = source.motions.filter((motion: FilmMotion) => motion.id !== id);
  });
}

export function changeMotionScope(scene: any, shotId: string, id: string, scope: MotionScope): string {
  let resultId = id;
  fail(scope === 'shot' || scope === 'film', 'Choose this shot or across cuts.');
  edit(scene, draft => {
    const item = entry(draft, shotId, id); if (item.scope === scope) return;
    const shot = findShot(draft, shotId), motion = item.motion;
    const source = item.scope === 'film' ? draft : shot, destination = scope === 'film' ? draft : shot;
    motion.startFrame += scope === 'film' ? shot.startFrame - 1 : 1 - shot.startFrame;
    fail(motion.startFrame >= 1, 'This movement begins before the selected shot. Move its start into this shot before changing scope.');
    source.motions = source.motions.filter((value: FilmMotion) => value.id !== id);
    if ((destination.motions ?? []).some((value: FilmMotion) => value.id === motion.id)) {
      const ids = new Set([...(draft.motions ?? []), ...draft.shots.flatMap((item: any) => item.motions ?? [])].map((value: FilmMotion) => value.id));
      let index = 1; while (ids.has(`motion-${index}`)) index++;
      resultId = motion.id = `motion-${index}`;
    }
    (destination.motions ??= []).push(motion);
  });
  return resultId;
}

export function setMotionKeys(scene: any, shotId: string, id: string, keys: FilmMotionKey[] | undefined) {
  edit(scene, draft => {
    const motion = entry(draft, shotId, id).motion;
    if (keys === undefined) delete motion.keys; else motion.keys = structuredClone(keys);
  });
}

/** Retiming preserves seconds and rejects collisions instead of dropping authored samples. */
export function retimeMotions(motions: FilmMotion[] | undefined, ratio: number): FilmMotion[] | undefined {
  if (!motions) return undefined;
  return motions.map(source => {
    const motion = structuredClone(source);
    motion.startFrame = Math.round((source.startFrame - 1) * ratio) + 1;
    motion.durationFrames = Math.round((source.durationFrames - 1) * ratio) + 1;
    fail(motion.durationFrames >= 2, 'A motion would collapse to one frame. Keep a higher frame rate or longer shot.');
    let previous = 0;
    for (const key of motion.keys ?? []) {
      key.frame = Math.round((key.frame - 1) * ratio) + 1;
      fail(key.frame > previous, 'Motion curve keys would overlap. Keep a higher frame rate or separate the keys.');
      previous = key.frame;
    }
    return motion;
  });
}

/** Same bounded progress evaluation as film.scene._motion_progress. */
export function motionProgressAtFrame(motion: FilmMotion, frame: number): number {
  const local = frame - motion.startFrame + 1;
  if (motion.keys?.length) {
    const keys = motion.keys;
    if (local <= keys[0].frame) return keys[0].value;
    for (let index = 0; index < keys.length - 1; index++) {
      const before = keys[index], after = keys[index + 1];
      if (local < after.frame) {
        if (before.interpolation === 'hold') return before.value;
        let u = (local - before.frame) / (after.frame - before.frame);
        if (before.interpolation === 'ease') u = u * u * (3 - 2 * u);
        return before.value + (after.value - before.value) * u;
      }
    }
    return keys.at(-1)!.value;
  }
  const u = Math.max(0, Math.min(1, (local - 1) / (motion.durationFrames - 1)));
  return motion.easing === 'ease' ? u * u * (3 - 2 * u) : motion.easing === 'hold' ? (u >= 1 ? 1 : 0) : u;
}

function rotateOrbit(offset: number[], degrees: number): number[] {
  // Quaternion multiplication order matches the canonical Python sampler.
  const multiply = (a: number[], b: number[]) => {
    const [x, y, z, w] = a, [X, Y, Z, W] = b;
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z];
  };
  const angle = degrees * Math.PI / 180 / 2;
  const q = [0, Math.sin(angle), 0, Math.cos(angle)];
  return multiply(multiply(q, [...offset, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3);
}

/** Pure camera projection for editorial operations; preview/export still use the canonical sampler. */
export function filmCameraPoseAtFrame(scene: any, shot: any, frame: number): CameraPose {
  const camera = cameraPoseAtFrame(shot, frame);
  const local = (shot.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
  const motion: FilmMotion | undefined = local ?? (scene.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
  if (!motion) return camera;
  const clock = local ? frame - shot.startFrame + 1 : frame;
  const value = motion.amount * motionProgressAtFrame(motion, clock), start = shot.camera.from;
  let offset = start.positionM.map((position: number, index: number) => position - start.targetM[index]);
  if (motion.kind === 'orbit') offset = rotateOrbit(offset, value);
  else {
    const radius = Math.hypot(...offset);
    offset = offset.map((component: number) => component * (1 - value / radius));
  }
  camera.positionM = offset.map((component: number, index: number) => component + start.targetM[index]);
  camera.targetM = [...start.targetM];
  return camera;
}

/** Avoid applying a shared camera action twice when opening a new shot from a rendered pose. */
export function cameraBaseForSharedMotion(scene: any, frame: number, pose: CameraPose): CameraPose {
  const motion: FilmMotion | undefined = (scene.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
  const base = structuredClone(pose);
  if (!motion) return base;
  const value = motion.amount * motionProgressAtFrame(motion, frame);
  let offset = base.positionM.map((position, index) => position - base.targetM[index]);
  if (motion.kind === 'orbit') offset = rotateOrbit(offset, -value);
  else {
    const radius = Math.hypot(...offset);
    fail(radius + value > .00001, 'This across-cuts camera move cannot continue from that framing. Reduce its distance before adding a shot.');
    offset = offset.map(component => component * (1 + value / radius));
  }
  base.positionM = offset.map((component, index) => component + base.targetM[index]);
  return base;
}
