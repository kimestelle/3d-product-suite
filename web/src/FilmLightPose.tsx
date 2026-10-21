import {VectorControl} from './EditorControls';
import {motionLights} from './filmMotion';
import {defaultLighting, ensureLighting, lightIdFromTarget} from './world';

/** Base pose of a studio light in the Film rail; motions start from these values. */
export default function FilmLightPose({scene, target, onChange, disabled = false}: {scene: any; target: string; onChange: (edit: (scene: any) => void) => void; disabled?: boolean}) {
  const id = lightIdFromTarget(target);
  const light = ((scene.lighting ?? defaultLighting(scene)).lights as any[]).find(item => item.id === id);
  if (!light || !motionLights(scene).some(item => item.id === id)) return null;
  const edit = (mutate: (light: any) => void) => onChange(next => {
    const item = ensureLighting(next).lights.find(entry => entry.id === id);
    if (!item) return;
    mutate(item);
    // A light must keep a direction: nudge apart when position and aim coincide.
    if (item.positionM.every((value: number, index: number) => Math.abs(value - item.targetM[index]) < .00001)) item.positionM[1] += .001;
  });
  return <div className="gesso-panel film-pose-inspector">
    <fieldset className="film-camera-fields" disabled={disabled}>
      <section className="gesso-section" aria-label="light position controls">
        <VectorControl label="Position" unit="m" step={.01} values={light.positionM} onChange={(axis, value) => edit(item => {item.positionM[axis] = value;})}/>
      </section>
      <section className="gesso-section" aria-label="light aim controls">
        <VectorControl label="Aim at" unit="m" step={.01} values={light.targetM} onChange={(axis, value) => edit(item => {item.targetM[axis] = value;})}/>
      </section>
    </fieldset>
    <p className="gesso-meta">Orbit, Move and Aim motions start from this pose. Power, cone and colour live in World → Lighting.</p>
  </div>;
}
