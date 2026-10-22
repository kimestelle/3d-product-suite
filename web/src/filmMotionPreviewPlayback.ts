import {STATIC_MOTION_QUERY} from './motionPolicy';
import {motionDiagramPose, type MotionDiagramSpec} from './filmMotionDiagram';

/** Only the contacted diagram runs. Native path animation keeps React and WebGL idle. */
export function mountFilmMotionPreview(root: HTMLElement, spec: MotionDiagramSpec, disabled = false): () => void {
  if (disabled || spec.kind === 'pose') return () => {};
  const doc = root.ownerDocument, media = window.matchMedia(STATIC_MOTION_QUERY);
  const connection = (navigator as Navigator & {connection?: EventTarget & {saveData?: boolean}}).connection;
  let visible = typeof IntersectionObserver === 'undefined', hovered = false, focused = false, disposed = false;
  let animations: Animation[] | undefined;
  const setRunning = () => {
    const running = !disposed && visible && !doc.hidden && !media.matches && !connection?.saveData && (hovered || focused);
    if (running && !animations) {
      animations = [];
      // A short, normalized gesture explains the action. It never advances the film playhead.
      const poses = Array.from({length: 33}, (_, index) => motionDiagramPose(spec, index / 32));
      for (const key of ['subject', 'actor', 'beam'] as const) {
        const path = root.querySelector<SVGPathElement>(`[data-motion-path="${key}"]`);
        if (!path?.animate || !poses[0][key] || poses.every(pose => pose[key] === poses[0][key])) continue;
        try {
          const frames: Keyframe[] = poses.map(pose => ({d: `path("${pose[key]}")`}));
          const animation = path.animate(frames, {duration: 1800, easing: 'ease-in-out', iterations: Infinity, direction: 'alternate', fill: 'both'});
          animation.pause(); animations.push(animation);
        } catch { /* A browser without SVG path animation keeps the complete static diagram. */ }
      }
    }
    root.dataset.previewPlaying = String(running && !!animations?.length);
    for (const animation of animations ?? []) running ? animation.play() : animation.pause();
  };
  const enter = (event: Event) => {if ((event as PointerEvent).pointerType !== 'touch') {hovered = true; setRunning();}};
  const leave = () => {hovered = false; setRunning();};
  const focus = () => {focused = root.matches(':focus-visible') || !!root.querySelector(':focus-visible'); setRunning();};
  const blur = (event: Event) => {if (!root.contains((event as FocusEvent).relatedTarget as Node | null)) {focused = false; setRunning();}};
  const pointerDown = () => {focused = false; setRunning();};
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting); setRunning();
  }, {threshold: 0});
  observer?.observe(root);
  root.addEventListener('pointerenter', enter);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('pointercancel', leave);
  root.addEventListener('pointerdown', pointerDown);
  root.addEventListener('focusin', focus);
  root.addEventListener('focusout', blur);
  doc.addEventListener('visibilitychange', setRunning);
  media.addEventListener('change', setRunning);
  connection?.addEventListener('change', setRunning);
  // A keyboard-selected action can remain focused when its axis or target changes.
  focus();
  return () => {
    disposed = true;
    for (const animation of animations ?? []) animation.cancel();
    observer?.disconnect();
    root.removeEventListener('pointerenter', enter);
    root.removeEventListener('pointerleave', leave);
    root.removeEventListener('pointercancel', leave);
    root.removeEventListener('pointerdown', pointerDown);
    root.removeEventListener('focusin', focus);
    root.removeEventListener('focusout', blur);
    doc.removeEventListener('visibilitychange', setRunning);
    media.removeEventListener('change', setRunning);
    connection?.removeEventListener('change', setRunning);
    delete root.dataset.previewPlaying;
  };
}
