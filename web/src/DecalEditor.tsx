import {UiIcon} from './UiIcon';
import {useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent} from 'react';
import {NumberControl} from './EditorControls';
import {decalIntersectsUv, type ProductDecal, type UvLayout} from './decals';

export function decalForPart(scene: any, partId: string | null, selectedId: string | null): ProductDecal | undefined {
  const decals: ProductDecal[] = scene?.product?.decals ?? [];
  return decals.find(decal => decal.partId === partId && decal.id === selectedId)
    ?? decals.find(decal => decal.partId === partId);
}

export function newDecal(scene: any, partId: string, componentId: string, layout: UvLayout): ProductDecal {
  return {id: `decal-${crypto.randomUUID()}`, partId, componentId,
    text: scene.product.label?.text ?? 'gesso', subtitle: scene.product.label?.subtitle ?? '',
    centerUv: layout.suggestedCenterUv ?? [.5, .5], sizeUv: layout.suggestedSizeUv ?? [.3, .2],
    rotationDeg: 0, heightM: .0002, bevelM: .0001};
}

export function DecalControls({scene, partId, decal, layout, onSelect, onAdd, onChange}: {
  scene: any; partId: string; decal?: ProductDecal; layout: UvLayout | null;
  onSelect: (id: string) => void; onAdd: () => void; onChange: (edit: (scene: any) => void) => void;
}) {
  const decals: ProductDecal[] = (scene.product.decals ?? []).filter((item: ProductDecal) => item.partId === partId);
  const edit = (patch: Partial<ProductDecal>) => onChange(next => {
    const target = next.product.decals?.find((item: ProductDecal) => item.id === decal?.id);
    if (target) {Object.assign(target, patch); target.bevelM = Math.min(target.bevelM, target.heightM / 2);}
  });
  const ready = !!layout && !layout.missingUv && layout.triangleCount > 0;
  return <>
    <section className="gesso-section">
      <div className="gesso-section-heading">Artwork</div>
      {decals.length > 1 && <label className="gesso-field"><span>Decal</span><select value={decal?.id} onChange={event => onSelect(event.target.value)}>
        {decals.map((item, index) => <option key={item.id} value={item.id}>{item.text || `Decal ${index + 1}`}</option>)}
      </select></label>}
      {!decal && <p className="gesso-meta">{ready ? 'Place artwork on this part’s UV map.' : layout ? 'This part has no usable UVs. Select a mesh with UVs in the tree.' : 'Loading this part’s UVs…'}</p>}
      <button type="button" disabled={!ready} onClick={onAdd}>{decal ? 'Add another decal' : 'Add decal'}</button>
      {decal && <>
        <label className="gesso-field"><span>Text</span><input aria-label="Decal text" value={decal.text} maxLength={40} onChange={event => edit({text: event.target.value})}/></label>
        <label className="gesso-field"><span>Descriptor</span><input aria-label="Decal descriptor" value={decal.subtitle} maxLength={80} onChange={event => edit({subtitle: event.target.value})}/></label>
      </>}
    </section>
    {decal && <>
      <section className="gesso-section"><div className="gesso-section-heading">Relief</div>
        <NumberControl label="Height" ariaLabel="Decal relief height" value={decal.heightM * 1000} min={0} max={10} step={.05} unit="mm" onChange={value => edit({heightM: value / 1000})}/>
        <NumberControl label="Bevel" ariaLabel="Decal bevel" value={decal.bevelM * 1000} min={0} max={decal.heightM * 500} step={.01} unit="mm" onChange={value => edit({bevelM: value / 1000})}/>
        <p className="gesso-meta">Raised label with a bevelled edge.</p>
      </section>
      <details className="gesso-disclosure"><summary>Placement / UV</summary><div className="gesso-panel">
      <section className="gesso-section"><div className="gesso-section-heading">Position / UV</div>
        <NumberControl label="U" ariaLabel="Decal U" value={decal.centerUv[0] * 100} min={0} max={100} step={1} unit="%" onChange={value => edit({centerUv: [value / 100, decal.centerUv[1]]})}/>
        <NumberControl label="V" ariaLabel="Decal V" value={decal.centerUv[1] * 100} min={0} max={100} step={1} unit="%" onChange={value => edit({centerUv: [decal.centerUv[0], value / 100]})}/>
        <NumberControl label="Rotation" ariaLabel="Decal rotation" value={decal.rotationDeg} min={-180} max={180} step={1} unit="°" onChange={rotationDeg => edit({rotationDeg})}/>
      </section>
      <section className="gesso-section"><div className="gesso-section-heading">Size / UV</div>
        <NumberControl label="Width" ariaLabel="Decal width" value={decal.sizeUv[0] * 100} min={1} max={100} step={1} unit="%" onChange={value => edit({sizeUv: [value / 100, decal.sizeUv[1]]})}/>
        <NumberControl label="Height" ariaLabel="Decal UV height" value={decal.sizeUv[1] * 100} min={1} max={100} step={1} unit="%" onChange={value => edit({sizeUv: [decal.sizeUv[0], value / 100]})}/>
      </section>
      </div></details>
      <button type="button" className="gesso-text-button" onClick={() => onChange(next => {next.product.decals = next.product.decals.filter((item: ProductDecal) => item.id !== decal.id);})}>Remove decal</button>
    </>}
  </>;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
/** Matches SVG's centered square viewBox. Empty letterbox space is not a UV edge. */
export function uvPointFromClient(clientX: number, clientY: number, bounds: {left: number; top: number; width: number; height: number}, clampToTile = false): [number, number] | null {
  const size = Math.min(bounds.width, bounds.height);
  if (size <= 0) return null;
  const u = (clientX - bounds.left - (bounds.width - size) / 2) / size;
  const v = 1 - (clientY - bounds.top - (bounds.height - size) / 2) / size;
  if (!Number.isFinite(u) || !Number.isFinite(v) || (!clampToTile && (u < 0 || u > 1 || v < 0 || v > 1))) return null;
  return [clamp(u), clamp(v)];
}

/** Hit the rotated artwork rectangle; empty UV space belongs to the camera. */
export function decalDragOffset(point: [number, number], decal: ProductDecal): [number, number] | null {
  const angle = -decal.rotationDeg * Math.PI / 180;
  const dx = point[0] - decal.centerUv[0], dy = point[1] - decal.centerUv[1];
  const within = Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) <= decal.sizeUv[0] / 2
    && Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) <= decal.sizeUv[1] / 2;
  return within ? [dx, dy] : null;
}

export function UvDecalOverlay({layout, decal, partName, onPlace, onAdd, onHover, onInteractionSurface, disabled = false}: {
  layout: UvLayout | null; decal?: ProductDecal; partName: string;
  onPlace: (center: [number, number]) => void; onAdd: () => void; onHover?: (uv: [number, number] | null) => void;
  onInteractionSurface?: (element: HTMLDivElement | null) => void; disabled?: boolean;
}) {
  const instructions = useId();
  const hoverHandler = useRef(onHover);
  hoverHandler.current = onHover;
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const map = useRef<HTMLDivElement>(null);
  const scenePointers = useRef(new Set<number>());
  const drag = useRef<{pointerId: number; target: HTMLDivElement; offset: [number, number]; center: [number, number]} | null>(null);
  const cancel = useCallback(() => {
    const active = drag.current; drag.current = null; setDraft(null);
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  }, []);
  useEffect(() => {cancel();}, [decal?.id, layout?.partId, cancel]);
  useEffect(() => {
    onInteractionSurface?.(map.current);
    return () => {cancel(); scenePointers.current.clear(); onInteractionSurface?.(null);};
  }, [collapsed, onInteractionSurface, cancel]);
  const path = useMemo(() => (layout?.triangles ?? []).map(t => `M${t[0] * 1000},${(1 - t[1]) * 1000}L${t[2] * 1000},${(1 - t[3]) * 1000}L${t[4] * 1000},${(1 - t[5]) * 1000}Z`).join(''), [layout]);
  const ready = !!layout && !layout.missingUv && layout.triangleCount > 0;
  const center = draft ?? decal?.centerUv ?? [.5, .5];
  const outside = !!decal && !!layout && !layout.truncated && !decalIntersectsUv(layout.triangles, {...decal, centerUv: center as [number, number]});
  useEffect(() => {
    cancel(); hoverHandler.current?.(null);
    return () => {cancel(); hoverHandler.current?.(null);};
  }, [layout, collapsed, disabled, cancel]);
  useEffect(() => {
    const clear = () => {
      cancel(); scenePointers.current.clear(); hoverHandler.current?.(null);
      // Focus loss ends both gesture owners; OrbitControls can retain pointers
      // when a browser stops delivering the gesture's final pointerup.
      onInteractionSurface?.(null); onInteractionSurface?.(map.current);
    };
    const visibility = () => {if (document.hidden) clear();};
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', visibility);};
  }, [cancel, onInteractionSurface]);
  const point = (event: PointerEvent<HTMLDivElement>, clampToTile = false) =>
    uvPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), clampToTile);
  const hover = (event: PointerEvent<HTMLDivElement>) => onHover?.(ready && !disabled ? point(event) : null);
  return <section className={`gesso-uv-overlay ${collapsed ? 'is-collapsed' : ''}`} aria-label="Decal UV overlay">
    <div className="gesso-uv-heading"><span><b>{partName}</b><span>UV map</span></span><button type="button" aria-label={collapsed ? 'Expand UV map' : 'Collapse UV map'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><UiIcon name={collapsed ? "chevron" : "down"} size={14}/></button></div>
    {!collapsed && <>
      <div ref={map} className={`gesso-uv-map ${draft ? 'is-dragging' : ''}`} role="group" tabIndex={ready && !!decal && !disabled ? 0 : -1} aria-label={`Decal position on ${partName} UV map`} aria-describedby={instructions}
        onPointerEnter={hover}
        onPointerLeave={() => onHover?.(null)}
        onPointerDownCapture={event => {
          hover(event);
          // Claim the gesture before OrbitControls' native listener runs on this map.
          // A second finger must not start a camera gesture during a decal drag.
          if (drag.current) {event.preventDefault(); event.stopPropagation(); return;}
          const p = point(event);
          const offset = ready && decal && !disabled && event.button === 0
            && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
            && event.isPrimary && scenePointers.current.size === 0 && p ? decalDragOffset(p, decal) : null;
          if (!offset || !decal) {scenePointers.current.add(event.pointerId); return;}
          event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {pointerId: event.pointerId, target: event.currentTarget, offset, center: decal.centerUv};
          setDraft(decal.centerUv);
        }}
        onPointerMove={event => {
          hover(event);
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          const p = point(event, true); if (!p) return;
          const next: [number, number] = [clamp(p[0] - drag.current.offset[0]), clamp(p[1] - drag.current.offset[1])];
          drag.current.center = next; setDraft(next);
        }}
        onPointerUp={event => {
          scenePointers.current.delete(event.pointerId);
          if (event.pointerType === 'touch') onHover?.(null);
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          const next = drag.current.center; cancel();
          if (decal && (next[0] !== decal.centerUv[0] || next[1] !== decal.centerUv[1])) onPlace(next);
        }}
        onPointerCancel={event => {scenePointers.current.delete(event.pointerId); if (drag.current?.pointerId === event.pointerId) cancel(); onHover?.(null);}}
        onLostPointerCapture={event => {scenePointers.current.delete(event.pointerId); if (drag.current?.pointerId === event.pointerId) cancel();}}
        onKeyDown={event => {
          if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); cancel(); onHover?.(null); return;}
          if (!ready || !decal || disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? .1 : .01;
          onPlace([clamp(decal.centerUv[0] + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)), clamp(decal.centerUv[1] + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0))]);
        }}>
        <svg viewBox="0 0 1000 1000" aria-hidden="true">
          <path className="gesso-uv-grid" d="M250 0V1000M500 0V1000M750 0V1000M0 250H1000M0 500H1000M0 750H1000"/>
          <path className="gesso-uv-wire" d={path}/>
          {decal && <g transform={`translate(${center[0] * 1000} ${(1 - center[1]) * 1000}) rotate(${-decal.rotationDeg})`}>
            <rect className="gesso-uv-artwork" x={-decal.sizeUv[0] * 500} y={-decal.sizeUv[1] * 500} width={decal.sizeUv[0] * 1000} height={decal.sizeUv[1] * 1000}/>
            <text className="gesso-uv-artwork-text" textAnchor="middle" dominantBaseline="middle" fontSize={Math.min(decal.sizeUv[1] * 230, decal.sizeUv[0] * 1200 / Math.max(4, decal.text.length))}>{decal.text}</text>
            <path className="gesso-uv-center" d="M-12 0H12M0-12V12"/>
          </g>}
        </svg>
        {!ready && <div className="gesso-uv-empty">{layout ? 'No usable UVs on this part' : 'Loading UVs…'}</div>}
      </div>
      <div className="gesso-uv-caption"><div className="gesso-uv-coordinates"><span>0</span><span>{decal ? `U ${(center[0] * 100).toFixed(1)} · V ${(center[1] * 100).toFixed(1)}` : '0–1 UV tile'}</span><span>1</span></div>
      <p id={instructions} className="gesso-uv-hint">{decal ? 'Drag decal to place · drag elsewhere to orbit · arrows to nudge' : ready ? 'Hover to locate on the mesh. Add a decal to place artwork.' : 'Choose a part with UVs in the tree.'}</p>
      {ready && !decal && <button type="button" className="gesso-uv-add" disabled={disabled} onClick={onAdd}>Add decal</button>}
      {outside && <p className="gesso-uv-hint" role="status">Outside mapped surface — move the artwork onto a UV island.</p>}
      {layout?.overlap && <p className="gesso-uv-hint">Shared UVs repeat artwork across faces.</p>}
      {layout?.partialUv && <p className="gesso-uv-hint">Some meshes in this part have no UVs.</p>}
      {layout?.truncated && <p className="gesso-uv-hint">Wireframe simplified for this view.</p>}</div>
    </>}
  </section>;
}
