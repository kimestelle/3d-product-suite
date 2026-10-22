import {partTargetIds} from './partTargets';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {FilmMotionChoice, FilmMotionPreview} from './FilmMotionPreview';
import {motionDiagramSpec} from './filmMotionDiagram';
import {availableMotionKinds, listMotions, motionLights, LIGHT_MOTION_KINDS, type FilmMotion, type MotionKind} from './filmMotion';
import {filmTargetName, motionMeasure} from './FilmWorkspace';
import {frameObjectMotionKinds, type FrameSetup} from './frameSetup';
import {isLightTarget, lightTarget} from './world';
import './frame-setup.css';

export interface FrameSetupProps {
  scene: any;
  setup: FrameSetup;
  disabled?: boolean;
  error?: string;
  onTargets: (ids: string[]) => void;
  onObjectKind: (kind: MotionKind | null) => void;
  onCameraTarget: (id: string) => void;
  onCameraKind: (kind: 'orbit' | 'dolly' | null) => void;
  onPatchMotion: (patch: Partial<FilmMotion>) => void;
  onStage: (stage: 'objects' | 'camera') => void;
  onComplete: () => void;
  onDiscard: () => void;
}

export function frameHasInheritedMotion(scene: any): boolean {
  return (scene.motions ?? []).some((motion: FilmMotion) => motion.enabled) ||
    (scene.actions ?? []).length > 0 || (scene.animation?.tracks ?? []).some((track: any) => track.enabled);
}

/** Selecting the whole product replaces the part selection; selecting parts releases it. */
export function nextFrameTargets(current: string[], target: string, checked: boolean): string[] {
  // Lights are independent of the product/part choice and keep their selection.
  const lights = current.filter(id => isLightTarget(id) && id !== target);
  if (isLightTarget(target)) return checked ? [...current.filter(id => id !== target), target] : current.filter(id => id !== target);
  if (target === '$product') return checked ? ['$product', ...lights] : lights;
  const parts = current.filter(id => id !== '$product' && id !== target && !isLightTarget(id));
  return checked ? [...parts, target, ...lights] : [...parts, ...lights];
}

function mechanicalName(scene: any, targets: string[]): string {
  const types = targets.map(target => scene.actions?.find((action: any) => action.componentId === target)?.type);
  return types.every(type => type === 'lift') ? 'Lift' : types.every(type => type === 'screw') ? 'Unscrew' : 'Mechanism';
}

function kindName(scene: any, setup: FrameSetup, kind: MotionKind): string {
  return kind === 'mechanical' ? mechanicalName(scene, setup.targets) : {move: 'Move', rotate: 'Rotate', scale: 'Scale', orbit: 'Orbit', dolly: 'Push in', aim: 'Aim'}[kind];
}

function anchorHint(scene: any, target: string): string {
  const dependent = scene.actions?.find((action: any) => action.relativeTo === target);
  return dependent ? `Anchors ${filmTargetName(scene, dependent.componentId)}. Move Whole product to keep them together.` : 'Movement is unavailable for this part.';
}

export function FrameSetupObjects({scene, setup, disabled, onTargets, onCameraTarget}: FrameSetupProps) {
  const camera = setup.stage === 'camera';
  // Lights are animated alongside the product; the camera only aims at product geometry.
  const targets = ['$product', ...partTargetIds(scene),
    ...(camera ? [] : motionLights(scene).filter(light => light.enabled).map(light => lightTarget(light.id)))];
  return <section className="gesso-panel frame-setup-objects film-rail-panel" aria-label={camera ? 'Camera target' : 'Objects to animate'}>
    <header className="frame-setup-rail-heading"><h2>{camera ? 'Camera target' : 'Objects to animate'}</h2>{!camera && <span>{setup.targets.length} selected</span>}</header>
    <div className="film-rail-scroll">
    <p className="frame-setup-hint">{camera ? 'Choose what the camera points toward.' : 'Select the product, individual parts or lights.'}</p>
    <div className="frame-setup-targets gesso-selection-surface" role="group" aria-label={camera ? 'Aim target' : 'Moving objects'}>
      {targets.map(target => {
        const supported = camera || availableMotionKinds(scene, target).length > 0;
        const checked = camera ? setup.cameraTarget === target : setup.targets.includes(target);
        const hint = supported ? '' : anchorHint(scene, target);
        return <div className="frame-setup-target-row" key={target}>
          <label className="frame-setup-target" data-selected={checked} data-unavailable={!supported} title={hint || undefined}>
            <input type={camera ? 'radio' : 'checkbox'} name={camera ? 'frame-camera-target' : undefined} checked={checked} disabled={disabled || !supported} aria-label={`${camera ? 'Aim at' : 'Animate'} ${filmTargetName(scene, target)}`}
              onChange={event => camera ? onCameraTarget(target) : onTargets(nextFrameTargets(setup.targets, target, event.target.checked))}/>
            <span>{filmTargetName(scene, target)}</span>
            {target === '$product' && <small>all parts</small>}
            {isLightTarget(target) && <small>light</small>}
          </label>
          {hint && <p className="frame-setup-target-hint">{hint}</p>}
        </div>;
      })}
    </div>
    <p className="frame-setup-hint frame-setup-selection-note">{camera ? 'Aim is set at the scene’s start.' : 'Unselected objects stay visible.'}</p>
    </div>
  </section>;
}

function FrameMotionControls({motion, scene, shotId, disabled, onPatchMotion}: {motion: FilmMotion; scene: any; shotId: string; disabled?: boolean; onPatchMotion: FrameSetupProps['onPatchMotion']}) {
  const measure = motionMeasure(motion), fps = scene.render.fps;
  const shot = scene.shots.find((item: any) => item.id === shotId);
  const maxDuration = Math.max(1 / fps, (shot.endFrame - shot.startFrame - motion.startFrame + 1) / fps);
  return <section className="frame-setup-controls" aria-label="Selected motion settings">
    <NumberControl label={measure.label} ariaLabel="New scene motion amount" value={motion.amount * measure.factor} unit={measure.unit} step={measure.step}
      min={motion.kind === 'scale' ? 1 : motion.kind === 'mechanical' ? 0 : undefined} max={motion.kind === 'mechanical' ? 100 : undefined} disabled={disabled}
      onChange={value => onPatchMotion({amount: value / measure.factor})}/>
    {(motion.kind === 'move' || motion.kind === 'rotate') && <label className="gesso-field frame-setup-field"><span>Axis</span><select aria-label="New scene motion axis" value={motion.axis} disabled={disabled} onChange={event => onPatchMotion({axis: event.target.value as FilmMotion['axis']})}>
      {['x', 'y', 'z'].map(axis => <option key={axis} value={axis}>{axis.toUpperCase()}</option>)}
    </select></label>}
    <NumberControl label="Duration" ariaLabel="New scene motion duration" value={(motion.durationFrames - 1) / fps} min={1 / fps} max={maxDuration} unit="s" step={1 / fps} disabled={disabled}
      onChange={value => onPatchMotion({durationFrames: Math.round(value * fps) + 1})}/>
    <label className="gesso-field frame-setup-field"><span>Timing</span><select aria-label="New scene motion easing" value={motion.easing} disabled={disabled} onChange={event => onPatchMotion({easing: event.target.value as FilmMotion['easing']})}>
      <option value="ease">Ease in / out</option><option value="linear">Constant speed</option><option value="hold">Hold, then change</option>
    </select></label>
  </section>;
}

export function FrameSetupInspector(props: FrameSetupProps) {
  const {scene, setup, disabled, error, onObjectKind, onCameraKind, onPatchMotion, onStage, onComplete, onDiscard} = props;
  const camera = setup.stage === 'camera', inherited = frameHasInheritedMotion(scene);
  const entries = listMotions(scene, setup.shotId);
  const selectedMotion = entries.find(entry => camera ? entry.motion.id === setup.cameraMotionId : setup.objectMotionIds.includes(entry.motion.id))?.motion;
  const common = frameObjectMotionKinds(scene, setup.targets);
  const lightsOnly = setup.targets.length > 0 && setup.targets.every(isLightTarget);
  const kinds: MotionKind[] = camera ? ['orbit', 'dolly'] : lightsOnly ? [...LIGHT_MOTION_KINDS]
    : ['move', 'rotate', 'scale', ...(common.includes('mechanical') ? ['mechanical' as const] : [])];
  const selectedKind = camera ? setup.cameraKind : setup.objectKind;
  const objectReady = setup.objectKind === null || setup.targets.length > 0;
  const previewTarget = camera ? '$camera' : setup.targets[0] ?? '$product';
  return <section className="gesso-panel frame-setup-inspector film-rail-panel" aria-label="New scene setup">
    <div className="frame-setup-fixed-heading">
    <header className="frame-setup-heading"><span>New scene</span></header>
    <nav className="frame-setup-stages" aria-label="New scene steps">
      <button type="button" aria-current={!camera ? 'step' : undefined} aria-pressed={!camera} disabled={disabled} onClick={() => onStage('objects')}>Objects</button>
      <UiIcon name="chevron" size={12}/>
      <button type="button" aria-current={camera ? 'step' : undefined} aria-pressed={camera} disabled={disabled || !objectReady} onClick={() => onStage('camera')}>Camera</button>
    </nav>
    </div>
    <FilmMotionPreview spec={motionDiagramSpec(scene, previewTarget, selectedMotion?.kind ?? 'pose', selectedMotion)} label={selectedMotion ? kindName(scene, setup, selectedMotion.kind) : camera ? 'Framing' : 'Position'} disabled={disabled || selectedMotion?.enabled === false}/>
    <div className="film-rail-scroll">
    <div className="frame-setup-content">
      <div className="frame-setup-section-heading"><h2>{camera ? 'Camera movement' : 'Object movement'}</h2><span>{camera ? filmTargetName(scene, setup.cameraTarget) : setup.targets.length === 1 ? filmTargetName(scene, setup.targets[0]) : `${setup.targets.length} objects`}</span></div>
      <div className="frame-setup-kinds" role="group" aria-label={camera ? 'Camera movement choices' : 'Object movement choices'}>
        <button type="button" className="frame-setup-none" aria-pressed={selectedKind === null} disabled={disabled} onClick={() => camera ? onCameraKind(null) : onObjectKind(null)}><span>{inherited ? 'No added motion' : 'Keep still'}</span>{selectedKind === null && <UiIcon name="check"/>}</button>
        {kinds.map(kind => <FilmMotionChoice key={kind} spec={motionDiagramSpec(scene, previewTarget, kind)} label={kindName(scene, setup, kind)} selected={selectedKind === kind} disabled={disabled || (!camera && !common.includes(kind))} title={!camera && !common.includes(kind) ? 'Select objects that support this movement.' : undefined}
          onClick={() => camera ? onCameraKind(kind as 'orbit' | 'dolly') : onObjectKind(kind)}/>)}
      </div>
      {!camera && setup.targets.length === 0 && <p className="frame-setup-hint">Choose objects on the left, or continue without added movement.</p>}
      {selectedMotion && <FrameMotionControls motion={selectedMotion} scene={scene} shotId={setup.shotId} disabled={disabled} onPatchMotion={onPatchMotion}/>}
      {selectedMotion && !camera && setup.targets.length > 1 && <p className="frame-setup-hint">These settings apply to all {setup.targets.length} selected objects.</p>}
      {selectedMotion?.kind === 'mechanical' && <p className="frame-setup-hint">Uses each part’s confirmed axis and travel.</p>}
      {selectedMotion && !camera && (selectedMotion.kind === 'move' || selectedMotion.kind === 'rotate') && setup.targets.some(target => scene.actions?.some((action: any) => action.componentId === target)) && <p className="frame-setup-hint">Direct movement holds the selected part’s existing mechanism at rest in this scene.</p>}
      {camera && <p className="frame-setup-hint">Aim is set at the scene’s start.</p>}
      {inherited && selectedKind === null && <p className="frame-setup-inherited"><UiIcon name="clock"/><span>Across-cut animation continues.</span></p>}
      {error && <p className="frame-setup-error" role="alert">{error}</p>}
    </div>
    <footer className="frame-setup-footer">
      <div className="frame-setup-navigation">
        {camera && <button type="button" className="frame-setup-back" disabled={disabled} onClick={() => onStage('objects')}>Back</button>}
        <button type="button" className="frame-setup-next" disabled={disabled || !objectReady} onClick={() => camera ? onComplete() : onStage('camera')}><span>{camera ? 'Finish scene' : 'Next: camera'}</span>{!camera && <UiIcon name="chevron"/>}</button>
      </div>
      <button type="button" className="frame-setup-discard" onClick={onDiscard}>Discard scene</button>
    </footer>
    </div>
  </section>;
}
