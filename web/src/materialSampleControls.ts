import {Quaternion} from 'three';
import {rotateMaterialSample} from './materialSampleRotation';

/** Native gestures for the real sample mesh, independent of material/render updates. */
export function bindMaterialSampleControls(
  control: HTMLButtonElement,
  orientation: Quaternion,
  invalidate: () => void,
  onRelease?: (event: PointerEvent) => void,
) {
  let drag: {id: number; x: number; y: number; size: number; before: Quaternion} | null = null;
  let lastPressDragged = false;
  let previousPressDragged = false;

  const finish = (restore = false, event?: PointerEvent) => {
    const active = drag;
    drag = null;
    if (active && restore) orientation.copy(active.before);
    delete control.dataset.dragging;
    if (active && control.hasPointerCapture(active.id)) control.releasePointerCapture(active.id);
    if (event) onRelease?.(event);
    invalidate();
  };
  const cancel = () => {if (drag) finish(true);};
  const start = (event: PointerEvent) => {
    if (control.disabled || drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation(); control.focus({preventScroll: true});
    const rect = control.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (!Number.isFinite(size) || size <= 0) return;
    previousPressDragged = lastPressDragged;
    lastPressDragged = false;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, size, before: orientation.clone()};
    control.dataset.dragging = 'true';
    control.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) lastPressDragged = true;
    // Recompute from the press, so coalescing, dropped events and reversals cannot add drift.
    orientation.copy(drag.before);
    rotateMaterialSample(orientation, dx, dy, drag.size);
    invalidate();
  };
  const end = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return;
    move(event); finish(false, event);
  };
  const pointerCancel = (event: PointerEvent) => {if (drag?.id === event.pointerId) cancel();};
  const reset = () => {cancel(); orientation.identity(); invalidate();};
  const doubleClick = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (!lastPressDragged && !previousPressDragged) reset();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ' || event.key === 'Enter') {event.stopPropagation(); return;}
    if (event.key === 'Escape') {
      if (drag) {event.preventDefault(); event.stopPropagation(); cancel();}
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); cancel();
    if (event.key === 'Home') reset();
    else {
      const step = event.shiftKey ? 15 : 5;
      rotateMaterialSample(orientation, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, 180);
      invalidate();
    }
  };
  const activate = (event: MouseEvent) => {if (event.detail === 0) reset();};
  const view = control.ownerDocument.defaultView;
  control.addEventListener('pointerdown', start);
  control.addEventListener('pointermove', move);
  control.addEventListener('pointerup', end);
  control.addEventListener('pointercancel', pointerCancel);
  control.addEventListener('lostpointercapture', pointerCancel);
  control.addEventListener('keydown', keyboard);
  control.addEventListener('click', activate);
  control.addEventListener('dblclick', doubleClick);
  control.addEventListener('blur', cancel);
  view?.addEventListener('blur', cancel);
  return {
    isDragging: () => drag !== null,
    cancel,
    dispose() {
      cancel();
      control.removeEventListener('pointerdown', start);
      control.removeEventListener('pointermove', move);
      control.removeEventListener('pointerup', end);
      control.removeEventListener('pointercancel', pointerCancel);
      control.removeEventListener('lostpointercapture', pointerCancel);
      control.removeEventListener('keydown', keyboard);
      control.removeEventListener('click', activate);
      control.removeEventListener('dblclick', doubleClick);
      control.removeEventListener('blur', cancel);
      view?.removeEventListener('blur', cancel);
    },
  };
}
