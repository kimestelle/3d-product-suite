import {motionChannels, motionProgressAtFrame, type FilmMotion} from './filmMotion';
import {animationTracks, getPropertyValue, sampleTrack} from './keyframes';
import {partTargetIds} from './partTargets';
import type {Shot} from './sequence';
import {isLightTarget, lightIdFromTarget} from './world';

export type RandomSetupMovementKind = 'move' | 'rotate' | 'scale' | 'mechanical' | 'light';
export interface RandomSetupMovement {
  cameraMustHold: boolean;
  kinds: RandomSetupMovementKind[];
  /** Existing performance is retained; report mixed movement rather than normalizing it. */
  mixedAuthoredKinds: boolean;
}
const EPSILON = 1e-10;
const kindOrder: RandomSetupMovementKind[] = ['move', 'rotate', 'scale', 'mechanical', 'light'];
function varies(sample: (frame: number) => number, start: number, end: number, checkpoints: number[] = []): boolean {
  const frames = [end, ...checkpoints.filter(frame => frame > start && frame < end)], first = sample(start);
  return frames.some(frame => {const value = sample(frame); return Math.abs(value - first) > EPSILON * Math.max(1, Math.abs(first), Math.abs(value));});
}
function mechanismHasTravel(action: any): boolean {
  return !!action && (action.type === 'lift' ? Math.abs(action.distanceM) > EPSILON
    : Math.abs(action.turns) > EPSILON && (Math.abs(action.directionSign) > EPSILON || Math.abs(action.axialTravelPerRevolutionM) > EPSILON));
}
/** Same precedence as film.scene._effective_motions: local owners replace conflicting shared actions as a whole. */
function effectiveMotions(scene: any, shot: Shot): Array<{motion: FilmMotion; local: boolean}> {
  const local = (shot.motions ?? []).filter((motion: FilmMotion) => motion.enabled);
  const owned = new Set(local.flatMap((motion: FilmMotion) => motionChannels(motion).map(channel => `${motion.target}/${channel}`)));
  const shared = (scene.motions ?? []).filter((motion: FilmMotion) => motion.enabled
    && !motionChannels(motion).some(channel => owned.has(`${motion.target}/${channel}`)));
  return [...shared.map((motion: FilmMotion) => ({motion, local: false})), ...local.map((motion: FilmMotion) => ({motion, local: true}))];
}

/** Detect variation during this shot, not merely saved animation records. No source data changes. */
export function randomSetupMovement(scene: any, shot: Shot): RandomSetupMovement {
  const result = new Set<RandomSetupMovementKind>(), operations = new Set<string>();
  const record = (kind: RandomSetupMovementKind, operation: string = kind) => {result.add(kind); operations.add(operation);};
  if (shot.kind === 'image') return {cameraMustHold: false, kinds: [], mixedAuthoredKinds: false};
  const visibleParts = new Set(partTargetIds(scene));
  const visibleTarget = (target: string) => target === '$product' || visibleParts.has(target)
    || isLightTarget(target) && (scene.lighting?.lights ?? []).some((light: any) => light.id === lightIdFromTarget(target) && light.enabled);
  const motions = effectiveMotions(scene, shot).filter(({motion}) => motion.target !== '$camera' && visibleTarget(motion.target));
  const owned = new Set<string>();
  for (const {motion} of motions) {
    for (const channel of motionChannels(motion)) owned.add(`${motion.target}/${channel}`);
    // The native evaluator also suppresses implicit mechanics under move/rotate owners.
    if (motion.kind === 'move' || motion.kind === 'rotate') owned.add(`${motion.target}/motion`);
  }
  const actionFor = (target: string) => (scene.actions ?? []).find((action: any) => action.componentId === target);
  for (const {motion, local} of motions) {
    const offset = local ? shot.startFrame - 1 : 0, start = shot.startFrame - offset, end = shot.endFrame - offset;
    const amount = motion.kind === 'scale' ? motion.amount - 1 : motion.amount;
    if (Math.abs(amount) <= EPSILON || motion.kind === 'mechanical' && !mechanismHasTravel(actionFor(motion.target))) continue;
    if (isLightTarget(motion.target) && motion.kind === 'orbit') {
      const light = scene.lighting.lights.find((item: any) => item.id === lightIdFromTarget(motion.target));
      if (Math.hypot(light.positionM[0] - light.targetM[0], light.positionM[2] - light.targetM[2]) <= EPSILON) continue;
    }
    const checkpoints = (motion.keys ?? []).map(key => motion.startFrame + key.frame - 1);
    if (varies(frame => amount * motionProgressAtFrame(motion, frame), start, end, checkpoints))
      record(isLightTarget(motion.target) ? 'light' : motion.kind as RandomSetupMovementKind, isLightTarget(motion.target) ? `light:${motion.kind}` : motion.kind);
  }
  const tracks = animationTracks(scene).filter(track => track.enabled && visibleTarget(track.componentId));
  for (const track of tracks) {
    if (owned.has(`${track.componentId}/${track.property}`)) continue;
    if (track.property === 'motion' && !mechanismHasTravel(actionFor(track.componentId))) continue;
    if (varies(frame => sampleTrack(track, frame), shot.startFrame, shot.endFrame, track.keys.map(key => key.frame)))
      record(track.property === 'motion' ? 'mechanical' : track.property === 'scale' ? 'scale' : track.property.startsWith('rotation.') ? 'rotate' : 'move');
  }
  for (const action of scene.actions ?? []) {
    if (!visibleParts.has(action.componentId) || !mechanismHasTravel(action) || owned.has(`${action.componentId}/motion`)) continue;
    // A progress track owns the mechanism even when it holds a constant pose.
    if (tracks.some(track => track.componentId === action.componentId && track.property === 'motion')) continue;
    if (varies(frame => getPropertyValue(scene, action.componentId, 'motion', frame), shot.startFrame, shot.endFrame)) record('mechanical');
  }
  const kinds = kindOrder.filter(kind => result.has(kind));
  return {cameraMustHold: kinds.length > 0, kinds, mixedAuthoredKinds: operations.size > 1};
}
