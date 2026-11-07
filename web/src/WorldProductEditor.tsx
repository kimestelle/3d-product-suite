import type {ReactNode} from 'react';
import {VectorControl} from './EditorControls';
import {PRODUCT_SCALE_MAX, PRODUCT_SCALE_MIN} from './transforms';
import './world-objects.css';

/** The product's Stage instance shares the prop inspector while its parts stay in Product. */
export default function WorldProductEditor({scene, onChange, onClose, children}: {
  scene: any;
  onChange: (edit: (scene: any) => void) => void | boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dimensions = scene.product.dimensionsM.map((value: number) => value * (scene.placement.scale ?? 1));
  return <div id="world-object-settings" className="gesso-panel gesso-world-object-editor" ref={element => {
    if (document.activeElement?.matches('.gesso-stage-object-tree button:focus-visible')) {
      element?.querySelector<HTMLInputElement>('input')?.focus();
    }
  }} onKeyDown={event => {
    if (event.key === 'Escape' && !(event.target as HTMLElement).matches('input,select,textarea')) {
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  }}>
    <header className="gesso-world-object-heading">
      <div><span>Object settings</span><h2>{scene.product.displayName || 'Product'}</h2></div>
      <button type="button" className="gesso-text-button" onClick={onClose} aria-label="Close object settings">Done</button>
    </header>
    <div className="gesso-world-object-body">
      <section className="gesso-section">
        <VectorControl label="Product size" values={dimensions} factor={1000} step={.1} unit="mm" min={.000001}
          onChange={(axis, value) => onChange(next => {
            next.placement.scale = Math.max(PRODUCT_SCALE_MIN, Math.min(PRODUCT_SCALE_MAX, value / next.product.dimensionsM[axis]));
          })}/>
        <p className="gesso-meta">Dimensions stay in proportion.</p>
      </section>
      {children}
    </div>
  </div>;
}
