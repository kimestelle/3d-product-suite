import {isCameraHoldMotion} from './cameraMotionPresets';
import {useEffect, useState} from 'react';
import {displayPartName} from './hierarchy';
import {motionLabel, motionLights, type FilmMotion, type MotionKind, type MotionEntry} from './filmMotion';
import {isLightTarget, lightIdFromTarget} from './world';

export const round = (value: number) => Number(value.toFixed(3));
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function filmTargetName(scene: any, id: string): string {
  if (isLightTarget(id)) return motionLights(scene).find(light => light.id === lightIdFromTarget(id))?.name ?? lightIdFromTarget(id);
  return id === '$camera' ? 'Camera' : id === '$product' ? 'Whole product' : displayPartName(scene, id);
}

export function actionName(scene: any, target: string, kind: MotionKind): string {
  if (kind === 'mechanical') return scene.actions?.find((action: any) => action.componentId === target)?.type === 'screw' ? 'Unscrew' : 'Lift';
  return {move: 'Move', rotate: 'Rotate', scale: 'Scale', orbit: 'Orbit', dolly: 'Push in', aim: 'Aim'}[kind];
}

export function labelFor(scene: any, motion: FilmMotion) {
  if (isCameraHoldMotion(motion)) return 'Still';
  return motion.kind === 'mechanical' || motion.kind === 'dolly' ? actionName(scene, motion.target, motion.kind) : motionLabel(motion);
}

export function motionMeasure(motion: FilmMotion) {
  if (motion.kind === 'move' || motion.kind === 'dolly' || motion.kind === 'aim') return {label: 'Distance', factor: 1000, unit: 'mm', step: 1};
  if (motion.kind === 'rotate' || motion.kind === 'orbit') return {label: 'Angle', factor: 1, unit: '°', step: 1};
  if (motion.kind === 'scale') return {label: 'Final size', factor: 100, unit: '%', step: 1};
  return {label: 'Travel', factor: 100, unit: '%', step: 1};
}

export function motionBounds(entry: MotionEntry, shot: any) {
  const start = entry.motion.startFrame + (entry.scope === 'shot' ? shot.startFrame - 1 : 0);
  return {start, end: start + entry.motion.durationFrames - 1};
}

export function legacyCount(scene: any, target: string): number {
  return (scene.actions ?? []).filter((action: any) => action.componentId === target).length +
    (scene.animation?.tracks ?? []).filter((track: any) => track.componentId === target).length;
}

export function legacyMotions(scene: any) {
  const tracks = scene.animation?.tracks ?? [];
  const actions = (scene.actions ?? []).map((action: any, index: number) => {
    const driver = tracks.find((track: any) => track.componentId === action.componentId && track.property === 'motion' && track.enabled);
    return {id: `legacy-action-${index}`, target: action.componentId, name: action.type === 'screw' ? 'Unscrew' : 'Lift',
      start: driver?.keys[0]?.frame ?? Math.round(action.startSeconds * scene.render.fps) + 1,
      end: driver?.keys.at(-1)?.frame ?? Math.round((action.startSeconds + action.durationSeconds) * scene.render.fps) + 1};
  });
  const targets = [...new Set<string>(tracks.filter((track: any) => track.property !== 'motion' || !actions.some((action: any) => action.target === track.componentId)).map((track: any) => track.componentId))];
  return [...actions, ...targets.map(target => {
    const keys = tracks.filter((track: any) => track.componentId === target).flatMap((track: any) => track.keys);
    return {id: `legacy-keys-${target}`, target, name: 'Custom keys', start: Math.min(...keys.map((key: any) => key.frame)), end: Math.max(...keys.map((key: any) => key.frame))};
  })];
}

/** Validate on a draft before notifying the app, so a rejected edit never changes selection. */
export function useFilmEdits({scene, onChange, disabled}: {scene: any; onChange: (edit: (scene: any) => void) => void; disabled?: boolean}) {
  const [error, setError] = useState('');
  useEffect(() => setError(''), [scene]);
  const edit = <T,>(mutate: (draft: any) => T): {value: T; draft: any} | undefined => {
    if (disabled) return;
    try {
      const draft = structuredClone(scene), value = mutate(draft);
      onChange(next => {
        next.shots = draft.shots;
        next.render = draft.render;
        if (draft.actions !== undefined) next.actions = draft.actions;
        if (draft.motions !== undefined) next.motions = draft.motions;
        if (draft.animation !== undefined) next.animation = draft.animation;
        if (draft.lighting !== undefined && next.lighting === undefined) next.lighting = draft.lighting;
      });
      setError('');
      return {value, draft};
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'This edit could not be applied.');}
  };
  return {edit, error, setError};
}
