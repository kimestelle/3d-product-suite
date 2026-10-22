import type {CSSProperties} from 'react';
import chevron14 from './assets/gesso/interface/imgIconChevron_48be26ca.svg';
import chevron12 from './assets/gesso/interface/imgIconChevron1_577e8ef0.svg';
import down from './assets/gesso/interface/imgIconDown_bbbe208a.svg';
import minus from './assets/gesso/interface/imgIconMinus_28bdb800.svg';
import plus from './assets/gesso/interface/imgIconPlus_b0ff4678.svg';
import check from './assets/gesso/interface/imgIconCheck_4386244d.svg';
import eye from './assets/gesso/interface/imgIconEye_d185b591.svg';
import eyeoff from './assets/gesso/interface/imgIconEyeoff_47b34b7e.svg';
import lock12 from './assets/gesso/interface/imgIconLock_eb20f085.svg';
import lock14 from './assets/gesso/interface/imgIconLock_228cee0d.svg';
import alert12 from './assets/gesso/interface/imgIconAlert_74b0639a.svg';
import alert14 from './assets/gesso/interface/imgIconAlert_2ac135c8.svg';
import unavailable from './assets/gesso/interface/imgIconUnavailable_8c3a0738.svg';
import loader from './assets/gesso/interface/imgIconLoader_74b33c2b.svg';
import option from './assets/gesso/interface/imgIconOption_f0f4733e.svg';
import clock from './assets/gesso/interface/imgIconClock_918c3f26.svg';
import circle from './assets/gesso/interface/imgIconCircle_db14ad29.svg';
import undo from './assets/gesso/undo-2.svg';
import redo from './assets/gesso/redo-2.svg';
import history from './assets/gesso/history.svg';
import dice from './assets/gesso/dice-5.svg';

const icons = {
  chevron: [chevron14, 14], down: [down, 14], minus: [minus, 12], plus: [plus, 12],
  check: [check, 12], eye: [eye, 14], eyeoff: [eyeoff, 14], lock: [lock12, 12],
  alert: [alert12, 12], unavailable: [unavailable, 12], loader: [loader, 12],
  option: [option, 10], clock: [clock, 12], circle: [circle, 12],
  undo: [undo, 16], redo: [redo, 16], history: [history, 14.4], dice: [dice, 20],
} as const;

/** Figma and Lucide assets; the mask lets each state inherit its text color. */
export function UiIcon({name, size, className = ''}: {name: keyof typeof icons; size?: number; className?: string}) {
  let [url, dimension]: readonly [string, number] = icons[name];
  if (name === 'chevron' && size === 12) [url, dimension] = [chevron12, 12];
  if (name === 'lock' && size === 14) [url, dimension] = [lock14, 14];
  if (name === 'alert' && size === 14) [url, dimension] = [alert14, 14];
  return <span aria-hidden="true" className={`gesso-ui-icon ${className}`} style={{
    width: dimension, height: dimension, maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")`,
  } as CSSProperties}/>;
}
