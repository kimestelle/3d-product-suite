import {useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject} from 'react';
import {cameraTarget, editCamera, type CameraEnd, type CameraPose} from './camera';
import {cameraPoseAtFrame, cameraSourceEndFrame, offsetCameraFraming} from './cameraFraming';
import {shotAtFrame, setOutputDimensions} from './sequence';
import {createViewport} from './viewport';
import type {FilmGuideProjection} from './filmGuides';

type Viewport = ReturnType<typeof createViewport>;
type Props = {
  scene: any; samples: any[]; frame: number; mode: 'still' | 'video';
  active: boolean; enabled: boolean; guide: FilmGuideProjection | null;
  viewport: RefObject<Viewport | null>;
  onChange: (edit: (scene: any) => void) => void;
  onFrame: (frame: number) => void;
  onResetView: () => void;
};

/** Camera motions own the spatial pose for the whole shot, including held endpoints. */
export function cameraMotionOwnsPose(scene: any, shot: any): boolean {
  return [...(scene?.motions ?? []), ...(shot?.motions ?? [])].some(motion => motion.target === '$camera' && motion.enabled !== false);
}

const motionPoseMessage = 'Camera motion controls position. Select its motion to edit.';

/** One endpoint selection and one transaction for controls mounted on the image. */
export function useFilmCamera(props: Props) {
  const {scene, frame, mode, active, guide} = props;
  const shot = scene ? shotAtFrame(scene, frame) : null;
  const cameraMotionDriven = cameraMotionOwnsPose(scene, shot);
  const sourceEnd = shot ? cameraSourceEndFrame(shot) : 1;
  const [selection, setSelection] = useState<{shotId: string; end: CameraEnd} | null>(null);
  const end: CameraEnd = selection && shot && selection.shotId === shot.id ? selection.end : shot && frame !== shot.startFrame && frame === sourceEnd ? 'to' : 'from';
  const [error, setError] = useState('');
  const [targetId, onTargetChange] = useState('');
  useEffect(() => {if (targetId && !scene?.product.components.some((part: any) => part.id === targetId)) onTargetChange('');}, [scene, targetId]);
  const [draftGuide, setDraftGuide] = useState<FilmGuideProjection | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({...props, shot, end, cameraMotionDriven}); latest.current = {...props, shot, end, cameraMotionDriven};
  const gestureCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (shot && (frame === shot.startFrame || frame === sourceEnd))
      setSelection({shotId: shot.id, end: frame === shot.startFrame ? 'from' : 'to'});
  }, [shot?.id, shot?.startFrame, sourceEnd, frame]);
  useEffect(() => {gestureCleanup.current?.(); setError('');}, [scene, frame, mode, active]);
  useEffect(() => () => gestureCleanup.current?.(), []);

  const onEndChange = useCallback((nextEnd: CameraEnd) => {
    const current = latest.current; if (!current.shot) return;
    const sourceEnd = cameraSourceEndFrame(current.shot);
    if (nextEnd === 'to' && (sourceEnd > current.shot.endFrame || sourceEnd === current.shot.startFrame)) return;
    gestureCleanup.current?.();
    setSelection({shotId: current.shot.id, end: nextEnd});
    current.onFrame(nextEnd === 'from' ? current.shot.startFrame : sourceEnd);
    current.onResetView(); setError('');
  }, []);

  const updatePose = useCallback((edit: (pose: CameraPose) => void, allowMotionDriven = false) => {
    const current = latest.current;
    if (!current.enabled || !current.shot) return;
    if (current.cameraMotionDriven && !allowMotionDriven) {setError(motionPoseMessage); return;}
    const shotId = current.shot.id;
    const sourceEnd = cameraSourceEndFrame(current.shot);
    const endpoint = current.end === 'from' ? current.shot.startFrame : sourceEnd;
    const clippedLensEdit = allowMotionDriven && sourceEnd > current.shot.endFrame && current.frame === current.shot.endFrame;
    if (current.mode === 'video' && !clippedLensEdit && (current.frame !== endpoint || current.end === 'to' && sourceEnd === current.shot.startFrame)) return;
    try {
      const draft = structuredClone(current.scene);
      editCamera(draft, shotId, camera => {
        if (current.mode === 'still' || clippedLensEdit) {
          const pose: CameraPose = current.samples.find(sample => sample.frame === current.frame && sample.shotId === shotId)?.camera ?? cameraPoseAtFrame(current.shot, current.frame);
          offsetCameraFraming(camera, pose, edit);
        }
        else edit(camera[current.end]);
      });
      const camera = draft.shots.find((item: any) => item.id === shotId).camera;
      current.onChange(next => {const selected = next.shots.find((item: any) => item.id === shotId); if (selected) selected.camera = camera;});
      current.onFrame(current.frame); current.onResetView(); setError('');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Camera could not be updated.');}
  }, []);

  const onAspectChange = useCallback((width: number, height: number) => {
    const current = latest.current; if (!current.enabled || !current.scene) return;
    try {
      const draft = structuredClone(current.scene); setOutputDimensions(draft, width, height);
      current.onChange(next => {next.render.width = draft.render.width; next.render.height = draft.render.height;});
      setError('');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Output dimensions could not be updated.');}
  }, []);
  const onFocalLengthChange = useCallback((value: number) => updatePose(pose => {pose.focalLengthMm = value;}, true), [updatePose]);
  const onDepthOfFieldChange = useCallback((patch: {enabled?: boolean; fStop?: number; focusDistanceM?: number | null}) => {
    const current = latest.current; if (!current.enabled || !current.shot) return;
    const shotId = current.shot.id;
    try {
      const draft = structuredClone(current.scene);
      editCamera(draft, shotId, camera => {
        const {focusDistanceM, ...rest} = patch;
        const settings = {...{enabled: false, fStop: 2.8}, ...camera.depthOfField, ...rest};
        if (focusDistanceM === null) delete settings.focusDistanceM;
        else if (focusDistanceM !== undefined) settings.focusDistanceM = focusDistanceM;
        camera.depthOfField = settings;
      });
      const camera = draft.shots.find((item: any) => item.id === shotId).camera;
      current.onChange(next => {const selected = next.shots.find((item: any) => item.id === shotId); if (selected) selected.camera = camera;});
      setError('');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Focus could not be updated.');}
  }, []);
  const onAim = useCallback((componentId: string) => {
    const current = latest.current;
    try {
      const sample = current.samples.find(sample => sample.frame === current.frame && sample.shotId === current.shot?.id);
      const target = cameraTarget(current.scene, sample, componentId || undefined);
      updatePose(pose => {pose.targetM = target;});
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Target is unavailable.');}
  }, [updatePose]);

  const onTargetPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = latest.current;
    if (event.button !== 0 || !current.active || !current.enabled || current.cameraMotionDriven || !current.guide?.target.visible || !current.shot) return;
    if (current.mode === 'video' && (current.frame !== (current.end === 'from' ? current.shot.startFrame : cameraSourceEndFrame(current.shot)) || current.end === 'to' && cameraSourceEndFrame(current.shot) === current.shot.startFrame)) return;
    const start = {clientX: event.clientX, clientY: event.clientY};
    const gesture = current.viewport.current?.createCameraTargetGesture(start); if (!gesture) return;
    event.preventDefault(); event.stopPropagation(); gestureCleanup.current?.();
    const source = current.scene, projection = current.guide, element = event.currentTarget, pointerId = event.pointerId;
    const pose: CameraPose = current.samples.find(sample => sample.frame === current.frame && sample.shotId === current.shot!.id)?.camera ?? cameraPoseAtFrame(current.shot, current.frame);
    let point: [number, number, number] | null = null, moved = false;
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cleanup);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      gestureCleanup.current = null; setDraftGuide(null); setDragging(false);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (latest.current.scene !== source) {cleanup(); return;}
      point = gesture.move({clientX: pointer.clientX, clientY: pointer.clientY});
      if (!point) return;
      const dx = pointer.clientX - start.clientX, dy = pointer.clientY - start.clientY;
      moved = moved || Math.hypot(dx, dy) > 2;
      setDraftGuide({...projection, target: {...projection.target, x: projection.target.x + dx, y: projection.target.y + dy}, targetM: point,
        distanceM: Math.hypot(...pose.positionM.map((value, index) => value - point![index]))});
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const target = point; cleanup();
      if (moved && target && latest.current.scene === source) updatePose(next => {next.targetM = [...target];});
    };
    const cancel = (pointer: PointerEvent) => {if (pointer.pointerId === pointerId) cleanup();};
    const key = (keyboard: KeyboardEvent) => {if (keyboard.key === 'Escape') {keyboard.preventDefault(); keyboard.stopPropagation(); cleanup();}};
    gestureCleanup.current = cleanup; setDragging(true); setError('');
    element.setPointerCapture(pointerId);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true); window.addEventListener('blur', cleanup);
  }, [updatePose]);

  const onTargetKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    const current = latest.current; if (!current.enabled || current.cameraMotionDriven || !current.guide || dragging) return;
    const canvas = current.viewport.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const gesture = canvas?.createCameraTargetGesture({clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2});
    const step = event.shiftKey ? 10 : 1;
    const point = gesture?.nudge(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    if (point) updatePose(next => {next.targetM = [...point];});
  }, [dragging, updatePose]);

  return {end, cameraMotionDriven, targetId, onTargetChange, onEndChange, onAspectChange, onFocalLengthChange, onDepthOfFieldChange, onAim, onTargetPointerDown, onTargetKeyDown, guide: draftGuide ?? guide, error, dragging};
}
