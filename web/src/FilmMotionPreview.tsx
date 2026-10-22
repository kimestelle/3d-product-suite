import {useEffect, useRef} from 'react';
import {UiIcon} from './UiIcon';
import {motionDiagramDescription, motionDiagramPose, type MotionDiagramSpec} from './filmMotionDiagram';
import {mountFilmMotionPreview} from './filmMotionPreviewPlayback';
import './film-motion-preview.css';

function useMotionPreview<T extends HTMLElement>(spec: MotionDiagramSpec, disabled?: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => ref.current ? mountFilmMotionPreview(ref.current, spec, disabled) : undefined,
    [spec.kind, spec.actor, spec.axis, spec.mechanism, spec.direction, disabled]);
  return ref;
}

function MotionDiagram({spec}: {spec: MotionDiagramSpec}) {
  const pose = motionDiagramPose(spec, 0), end = motionDiagramPose(spec, 1);
  return <svg className="film-motion-diagram" viewBox="0 0 224 112" aria-hidden="true" focusable="false" data-motion-kind={spec.kind} data-motion-actor={spec.actor} data-motion-axis={spec.axis} data-motion-mechanism={spec.kind === 'mechanical' ? spec.mechanism : undefined}>
    {spec.kind !== 'pose' && <g className="film-diagram-endpoint">
      {pose.subject !== end.subject && <path d={end.subject}/>}
      {pose.actor !== end.actor && <path d={end.actor}/>}
    </g>}
    <path className="film-diagram-beam" d={pose.beam} data-motion-path="beam"/>
    <path className="film-diagram-object" d={pose.subject} data-motion-path="subject"/>
    <path className="film-diagram-actor" d={pose.actor} data-motion-path="actor"/>
  </svg>;
}

export function FilmMotionPreview({spec, label, disabled}: {spec: MotionDiagramSpec; label: string; disabled?: boolean}) {
  const ref = useMotionPreview<HTMLElement>(spec, disabled);
  return <figure ref={ref} className="film-motion-preview" tabIndex={spec.kind === 'pose' || disabled ? undefined : 0}
    aria-label={`${label} preview. ${motionDiagramDescription(spec)}. Diagram, not a scene render.`}
    title={spec.kind === 'pose' ? 'Framing diagram' : 'Hover or focus to preview this movement'}>
    <MotionDiagram spec={spec}/>
    <figcaption><span>{label}</span><small>Diagram</small></figcaption>
  </figure>;
}

export function FilmMotionChoice({spec, label, disabled, selected, title, onClick}: {
  spec: MotionDiagramSpec; label: string; disabled?: boolean; selected?: boolean; title?: string; onClick: () => void;
}) {
  const ref = useMotionPreview<HTMLButtonElement>(spec, disabled);
  return <button ref={ref} type="button" className="film-motion-choice" disabled={disabled} aria-pressed={selected}
    title={title ?? `${motionDiagramDescription(spec)}. Hover or focus for a diagram preview.`} onClick={onClick}>
    <MotionDiagram spec={spec}/>
    <span className="film-motion-choice-label"><span>{label}</span><UiIcon name={selected ? 'check' : 'plus'} size={12}/></span>
  </button>;
}
