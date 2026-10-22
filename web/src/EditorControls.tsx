import {useEffect, useId, useRef, useState} from 'react';
import {UiIcon} from './UiIcon';

export interface NumberControlProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  ariaLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
}

/** Keep the native input, visible units and reversible draft in one measured row. */
export function NumberControl({label, value, onChange, min, max, step = 1, precision = 4, unit, ariaLabel, compact = false, disabled = false, readOnly = false, error}: NumberControlProps) {
  const id = useId();
  const currentText = String(Number(value.toFixed(precision)));
  const [draft, setDraft] = useState(currentText);
  const skipBlur = useRef(false);
  useEffect(() => setDraft(currentText), [currentText]);
  const setValue = (next: number) => {
    // Reset first: a rejected scene edit must not leave an unsaved value on screen.
    setDraft(currentText);
    if (!disabled && !readOnly && Number.isFinite(next)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(next.toFixed(8)))));
  };
  const commit = () => {
    if (skipBlur.current) {skipBlur.current = false; return;}
    if (draft.trim() === '' || draft === currentText) {setDraft(currentText); return;}
    setValue(Number(draft));
  };
  const stepValue = (direction: number) => {
    const candidate = draft.trim() === '' ? value : Number(draft);
    setValue((Number.isFinite(candidate) ? candidate : value) + direction * step);
  };
  const numericDraft = Number(draft);
  const bound = (number: number) => String(Number(number.toPrecision(6)));
  const draftError = draft.trim() === '' || !Number.isFinite(numericDraft) ? 'Enter a number' :
    (min !== undefined && numericDraft < min) || (max !== undefined && numericDraft > max) ?
      min !== undefined && max !== undefined ? `Enter ${bound(min)}–${bound(max)}` :
      min !== undefined ? `Enter ${bound(min)} or more` : `Enter ${bound(max!)} or less` : '';
  const message = error || (!disabled && !readOnly ? draftError : '');
  const description = [unit ? `${id}-unit` : '', message ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const name = ariaLabel ?? label;
  return <div className={`gesso-number-control${compact ? ' is-compact' : ''}`}>
    <div className={`gesso-control-row${compact ? ' gesso-control-compact' : ''}`} data-state={disabled ? 'disabled' : readOnly ? 'readonly' : message ? 'invalid' : 'default'}>
      <div className="gesso-control-main">
        <label className="gesso-control-label" htmlFor={id}>{label}</label>
        <input id={id} className="gesso-control-value" type="number" aria-label={name} aria-describedby={description} aria-invalid={message ? true : undefined}
          value={draft} min={min} max={max} step={step} disabled={disabled} readOnly={readOnly}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') {event.preventDefault(); event.currentTarget.blur();}
            if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); skipBlur.current = true; setDraft(currentText); event.currentTarget.blur();}
          }}/>
      </div>
      <span className="gesso-control-unit" id={`${id}-unit`}>{unit}</span>
      {!compact && <div className="gesso-control-tools">
        {readOnly ? <UiIcon name="lock" size={12}/> : disabled ? <UiIcon name="unavailable" size={12}/> : message ? <UiIcon name="alert" size={14}/> : <>
          <button className="gesso-control-step" type="button" aria-label={`Decrease ${name}`} disabled={min !== undefined && value <= min} onMouseDown={event => event.preventDefault()} onClick={() => stepValue(-1)}><UiIcon name="minus" size={12}/></button>
          <button className="gesso-control-step" type="button" aria-label={`Increase ${name}`} disabled={max !== undefined && value >= max} onMouseDown={event => event.preventDefault()} onClick={() => stepValue(1)}><UiIcon name="plus" size={12}/></button>
        </>}
      </div>}
    </div>
    {message && <p id={`${id}-error`} className="gesso-control-error" role="alert">{message}</p>}
  </div>;
}

export function VectorControl({label, values, onChange, factor = 1, step = 1, unit, min, max}: {
  label: string; values: number[]; onChange: (index: number, value: number) => void;
  factor?: number; step?: number; unit?: string; min?: number; max?: number;
}) {
  return <div className="gesso-vector gesso-vector-inline"><div className="gesso-section-heading">{label}{unit && <span>{unit}</span>}</div>
    <div className="gesso-vector-values">{['X', 'Y', 'Z'].map((axis, index) => <NumberControl compact key={axis} label={axis} ariaLabel={`${label} ${axis}`}
      value={values[index] * factor} min={min} max={max} step={step} unit={unit} onChange={value => onChange(index, value / factor)}/>)}</div></div>;
}
