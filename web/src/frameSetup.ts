import {cameraTarget, editCamera} from './camera';
import {addMotion, availableMotionKinds, cameraBaseForSharedMotion, filmCameraPoseAtFrame, updateMotion, validateFilmMotions, type FilmMotion, type MotionKind} from './filmMotion';
import {addShot} from './sequence';
import {isLightTarget} from './world';

export type FrameSetup = {
  shotId: string;
  stage: 'objects' | 'camera';
  targets: string[];
  objectKind: MotionKind | null;
  objectMotionIds: string[];
  cameraTarget: string;
  cameraKind: 'orbit' | 'dolly' | null;
  cameraMotionId: string | null;
};
export type FrameMotionPatch = Partial<Omit<FilmMotion, 'id' | 'target' | 'kind'>>;

const fail = (condition: unknown, message: string) => {if (!condition) throw new Error(message);};
const shotFor = (scene: any, shotId: string) => {
  const shot = scene.shots.find((item: any) => item.id === shotId);
  if (!shot) throw new Error('This frame is no longer in the film.');
  return shot;
};
function commit<T>(scene: any, operation: (draft: any) => T): T {
  const draft = structuredClone(scene);
  const result = operation(draft);
  validateFilmMotions(draft);
  scene.shots = draft.shots;
  scene.render = draft.render;
  if (draft.lighting !== undefined && scene.lighting === undefined) scene.lighting = draft.lighting;
  return result;
}
function objectTargets(scene: any, targets: string[]): string[] {
  fail(Array.isArray(targets), 'Choose objects from the product.');
  const selected = [...new Set(targets)];
  // Lights sit beside the product selection: they never compete with parts.
  fail(!selected.includes('$product') || selected.every(target => target === '$product' || isLightTarget(target)), 'Choose Whole product or individual parts, not both.');
  fail(selected.every(target => target === '$product' || isLightTarget(target) || scene.product.components.some((part: any) => part.id === target)), 'An object is no longer in this product.');
  fail(selected.every(target => !isLightTarget(target) || availableMotionKinds(scene, target).length > 0), 'A light is no longer in this rig.');
  return selected;
}
function parameters(motion: FilmMotion): FrameMotionPatch {
  const {id: _id, target: _target, kind: _kind, ...values} = structuredClone(motion);
  return values;
}

/** Available actions must apply to every selected object. */
export function frameObjectMotionKinds(scene: any, targets: string[]): MotionKind[] {
  if (!targets.length || (targets.includes('$product') && targets.some(target => target !== '$product' && !isLightTarget(target)))) return [];
  return availableMotionKinds(scene, targets[0]).filter(kind => kind !== 'dolly'
    && targets.every(target => availableMotionKinds(scene, target).includes(kind)));
}

export function createFrameSetup(scene: any, afterShotId?: string): FrameSetup {
  return commit(scene, draft => {
    const shotId = addShot(draft, afterShotId);
    const names = new Set(draft.shots.filter((shot: any) => shot.id !== shotId).map((shot: any) => shot.name));
    let name = 'Untitled', number = 2;
    while (names.has(name)) name = `Untitled ${number++}`;
    shotFor(draft, shotId).name = name;
    return {shotId, stage: 'objects', targets: ['$product'], objectKind: null, objectMotionIds: [],
      cameraTarget: '$product', cameraKind: null, cameraMotionId: null};
  });
}

/** Only this setup's local actions are replaced. Shared actions and custom work survive. */
export function setFrameObjects(scene: any, setup: FrameSetup, targets: string[], kind: MotionKind | null): FrameSetup {
  return commit(scene, draft => {
    const selected = objectTargets(draft, targets), shot = shotFor(draft, setup.shotId);
    fail(kind === null || (selected.length > 0 && frameObjectMotionKinds(draft, selected).includes(kind)), 'Choose a motion supported by every selected object.');
    const managed = new Set(setup.objectMotionIds);
    const old = (shot.motions ?? []).filter((motion: FilmMotion) => managed.has(motion.id));
    shot.motions = (shot.motions ?? []).filter((motion: FilmMotion) => !managed.has(motion.id));
    const ids = new Map<string, string>();
    if (kind !== null) {
      // Reinsert retained targets first so generated IDs cannot steal their identities.
      for (const target of selected) {
        const existing = old.find((motion: FilmMotion) => motion.target === target && motion.kind === kind);
        if (existing) {shot.motions.push(structuredClone(existing)); ids.set(target, existing.id);}
      }
      const template = old.find((motion: FilmMotion) => motion.kind === kind);
      for (const target of selected) {
        if (ids.has(target)) continue;
        const id = addMotion(draft, setup.shotId, target, kind);
        if (template) updateMotion(draft, setup.shotId, id, parameters(template));
        ids.set(target, id);
      }
    }
    return {...structuredClone(setup), stage: 'objects', targets: selected, objectKind: kind,
      objectMotionIds: selected.flatMap(target => ids.has(target) ? [ids.get(target)!] : [])};
  });
}

/** Aim at the evaluated object at the frame's start; this is a fixed target, not a follow constraint. */
export function setFrameCamera(scene: any, setup: FrameSetup, target: string, kind: 'orbit' | 'dolly' | null, sample: any): FrameSetup {
  return commit(scene, draft => {
    const shot = shotFor(draft, setup.shotId);
    objectTargets(draft, [target]);
    fail(kind === null || kind === 'orbit' || kind === 'dolly', 'Choose Orbit, Dolly or no added camera motion.');
    fail(sample?.frame === shot.startFrame, 'Wait for the preview at this frame’s start before choosing a camera target.');
    const visibleStart = filmCameraPoseAtFrame(draft, shot, shot.startFrame);
    const old: FilmMotion | undefined = (shot.motions ?? []).find((motion: FilmMotion) => motion.id === setup.cameraMotionId);
    shot.motions = (shot.motions ?? []).filter((motion: FilmMotion) => motion.id !== setup.cameraMotionId);
    const point = cameraTarget(draft, sample, target === '$product' ? undefined : target);
    // Construct the final owner before validating the new aim. Removing a local
    // action must not briefly expose a conflicting shared camera constraint.
    let cameraMotionId: string | null = null;
    if (kind !== null) {
      const ids = new Set([...(draft.motions ?? []), ...draft.shots.flatMap((item: any) => item.motions ?? [])].map((motion: FilmMotion) => motion.id));
      let number = 1; while (ids.has(`motion-${number}`)) number++;
      cameraMotionId = old?.kind === kind ? old.id : `motion-${number}`;
      const distance = Math.hypot(...visibleStart.positionM.map((position: number, index: number) => position - point[index]));
      const autoFocus = shot.camera.depthOfField?.enabled && shot.camera.depthOfField.focusDistanceM === undefined;
      const minimum = autoFocus ? Math.max(shot.camera.from.focalLengthMm, shot.camera.to.focalLengthMm) / 1000 : .00001;
      const motion: FilmMotion = old?.kind === kind ? structuredClone(old) : {
        id: cameraMotionId, target: '$camera', kind, axis: 'y',
        amount: kind === 'orbit' ? 30 : Math.min(.05, Math.max(0, (distance - minimum) / 2)),
        startFrame: 1, durationFrames: Math.max(2, Math.min(shot.endFrame - shot.startFrame + 1, Math.round(draft.render.fps * 2) + 1)),
        easing: 'ease', enabled: true,
      };
      shot.motions.push(motion);
    }
    const localOwner: FilmMotion | undefined = (shot.motions ?? []).find((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
    const aimed = {...visibleStart, targetM: [...point]};
    // Rebase against the FINAL owner, including custom keys with nonzero start
    // progress. Changing scope or aim must not apply an orbit/dolly twice.
    const base = cameraBaseForSharedMotion(localOwner ? {motions: [localOwner]} : draft,
      localOwner ? 1 : shot.startFrame, aimed);
    editCamera(draft, setup.shotId, camera => {
      const offset = base.positionM.map((value, index) => value - camera.from.positionM[index]);
      camera.from.positionM = [...base.positionM];
      camera.to.positionM = camera.to.positionM.map((value, index) => value + offset[index]);
      camera.from.targetM = [...point]; camera.to.targetM = [...point];
    });
    return {...structuredClone(setup), stage: 'camera', cameraTarget: target, cameraKind: kind, cameraMotionId};
  });
}

/** Batch parameter edits commit together or leave the entire scene unchanged. */
export function patchFrameMotions(scene: any, setup: FrameSetup, patch: FrameMotionPatch): void {
  fail(!('id' in patch) && !('target' in patch) && !('kind' in patch), 'Use the object and motion choices to change what this action controls.');
  commit(scene, draft => {
    const shot = shotFor(draft, setup.shotId);
    const ids = setup.stage === 'objects' ? setup.objectMotionIds : setup.cameraMotionId ? [setup.cameraMotionId] : [];
    fail(ids.length > 0, 'Choose a motion before adjusting its parameters.');
    for (const id of ids) {
      fail((shot.motions ?? []).some((motion: FilmMotion) => motion.id === id), 'This motion changed outside frame setup. Choose the motion again to edit it.');
      updateMotion(draft, setup.shotId, id, patch);
    }
  });
}
