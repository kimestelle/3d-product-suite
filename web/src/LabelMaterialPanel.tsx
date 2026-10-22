import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assetUrl } from './runtime';
import './labelMaterials.css';

export type TextureAsset = { format: 'png' | 'jpg'; path: string; sha256: string; widthPx: number; heightPx: number };
export type LabelMapping = {
  mode: 'planar' | 'cylindrical' | 'uv';
  face: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  scale: [number, number]; offset: [number, number]; rotationDegrees: number;
};
type SurfaceMaterial = { baseColor: number[]; roughness: number; metallic: number; transmission?: number; ior?: number };
type Props = {
  scene: any; selected: string | null; onSelect: (id: string) => void;
  uploadAvailable?: boolean;
  onChange: (edit: (scene: any) => void) => void;
  onUpload: (file: File) => Promise<TextureAsset>;
  onTemplate: (componentId: string, mapping: LabelMapping) => void;
};
export const LABEL_MAX_BYTES = 8 * 1024 * 1024;
export const LABEL_FINISHES = {
  paper: { name: 'Matte paper', roughness: .6, metallic: 0 },
  vinyl: { name: 'Glossy vinyl', roughness: .18, metallic: 0 },
  foil: { name: 'Metallic foil', roughness: .25, metallic: 1 },
};
export const SURFACE_FINISHES = {
  mattePlastic: { name: 'Matte plastic', roughness: .65, metallic: 0, transmission: 0, ior: 1.5 },
  glossPlastic: { name: 'Glossy plastic', roughness: .16, metallic: 0, transmission: 0, ior: 1.5 },
  ceramic: { name: 'Glazed ceramic', roughness: .25, metallic: 0, transmission: 0, ior: 1.5 },
  metal: { name: 'Brushed metal', roughness: .3, metallic: 1, transmission: 0, ior: 1.5 },
  glass: { name: 'Glass', roughness: .08, metallic: 0, transmission: 1, ior: 1.5 },
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rounded = (value: number) => Number(value.toFixed(5));
export function labelUploadError(file: Pick<File, 'name' | 'size' | 'type'>): string {
  if (!/\.(png|jpe?g)$/i.test(file.name) || (file.type && !['image/png', 'image/jpeg'].includes(file.type))) return 'Choose a PNG or JPEG image. Use a transparent PNG for a cutout label.';
  if (file.size <= 0) return 'This image is empty. Choose another file.';
  if (file.size > LABEL_MAX_BYTES) return 'The image exceeds the 8 MiB limit.';
  return '';
}
export function labelTarget(scene: any, selected: string | null): any | undefined {
  const components = scene.product?.components || [];
  return components.find((component: any) => component.id === selected)
    || components.find((component: any) => component.id === scene.product?.label?.componentId) || components[0];
}
export function mappingDimensions(component: any, mapping: Pick<LabelMapping, 'mode' | 'face'>): [number, number] {
  const [x, y, z] = (component.sizeM || [1, 1, 1]).map((v: number) => Math.max(.00001, v));
  if (mapping.mode === 'uv') return [1, 1];
  if (mapping.mode === 'cylindrical') return [2 * Math.PI * Math.sqrt((x * x + z * z) / 8), y];
  if (mapping.face === 'left' || mapping.face === 'right') return [z, y];
  if (mapping.face === 'top' || mapping.face === 'bottom') return [x, z];
  return [x, y];
}
export function defaultLabelMapping(component: any): LabelMapping {
  return { mode: component.shape === 'cylinder' ? 'cylindrical' : 'planar', face: 'front', scale: [.7, .7], offset: [0, 0], rotationDegrees: 0 };
}
export function fitLabelMapping(component: any, asset: TextureAsset, mapping = defaultLabelMapping(component)): LabelMapping {
  const [w, h] = mappingDimensions(component, mapping);
  let width = .7;
  let height = width * w / h * asset.heightPx / asset.widthPx;
  if (height > .9) { width *= .9 / height; height = .9; }
  return { ...mapping, scale: [clamp(width, .01, 10), clamp(height, .01, 10)], offset: [0, 0], rotationDegrees: 0 };
}
export function resizeLabel(mapping: LabelMapping, axis: 0 | 1, value: number, locked: boolean): LabelMapping {
  const scale: [number, number] = [...mapping.scale];
  const target = clamp(value, .01, 10);
  if (locked) {
    const factor = clamp(target / scale[axis], Math.max(.01 / scale[0], .01 / scale[1]), Math.min(10 / scale[0], 10 / scale[1]));
    scale[0] = rounded(scale[0] * factor); scale[1] = rounded(scale[1] * factor);
  } else scale[axis] = target;
  return { ...mapping, scale };
}
export function dragLabelOffset(offset: [number, number], dx: number, dy: number, width: number, height: number): [number, number] {
  return [rounded(clamp(offset[0] + dx / Math.max(1, width), -5, 5)), rounded(clamp(offset[1] - dy / Math.max(1, height), -5, 5))];
}
export function labelPreviewStyle(mapping: LabelMapping, planeAspect: number): CSSProperties {
  const radians = mapping.rotationDegrees * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  const [x, y] = mapping.scale;
  // Rotation happens in artwork UVs before scale; CSS uses downward screen Y.
  // The plane aspect converts UV distances into preview pixels on each axis.
  const matrix = [x * c, -y / planeAspect * s, x * planeAspect * s, y * c].map(rounded);
  return { left: `${50 + mapping.offset[0] * 100}%`, top: `${50 - mapping.offset[1] * 100}%`, width: '100%', height: '100%',
    transform: `translate(-50%, -50%) matrix(${matrix.join(',')},0,0)` };
}
export function hexToLinear(hex: string, alpha = 1): number[] {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  return [...rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4), alpha];
}
export function linearToHex(color: number[]): string {
  return '#' + color.slice(0, 3).map(value => {
    const c = clamp(value, 0, 1);
    return Math.round(255 * (c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055)).toString(16).padStart(2, '0');
  }).join('');
}
export function labelMaterial(material?: Partial<SurfaceMaterial>): SurfaceMaterial {
  return { baseColor: [1, 1, 1, 1], roughness: .6, metallic: 0, ...material };
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function Numeric({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <Field label={label}><input aria-label={label} type="number" value={rounded(value)} min={min} max={max} step={step}
    onChange={event => { const value = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(value)) onChange(clamp(value, min, max)); }}/></Field>;
}
function Slider({ label, value, min = 0, max = 1, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <Field label={label}><div className="label-slider"><input aria-label={label} type="range" min={min} max={max} step={.01} value={value}
    onChange={event => onChange(Number(event.target.value))}/><output>{value.toFixed(2)}</output></div></Field>;
}
function Color({ label, value, onChange }: { label: string; value: number[]; onChange: (value: number[]) => void }) {
  return <Field label={label}><div className="color-control"><input aria-label={label} type="color" value={linearToHex(value)}
    onChange={event => onChange(hexToLinear(event.target.value, value[3] ?? 1))}/><code>{linearToHex(value).toUpperCase()}</code></div></Field>;
}
function finishKey(material: SurfaceMaterial, finishes: Record<string, { roughness: number; metallic: number; transmission?: number }>): string {
  return Object.entries(finishes).find(([, finish]) => Math.abs(material.roughness - finish.roughness) < .0001 && Math.abs(material.metallic - finish.metallic) < .0001
    && (finish.transmission === undefined || Math.abs((material.transmission || 0) - finish.transmission) < .0001))?.[0] || 'custom';
}

export default function LabelMaterialPanel({ scene, selected, onSelect, onChange, onUpload, onTemplate, uploadAvailable = true }: Props) {
  const component = labelTarget(scene, selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [aspectLocked, setAspectLocked] = useState(true);
  const [guideMappings, setGuideMappings] = useState<Record<string, LabelMapping>>({});
  const tintFilterId = 'label-tint-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const drag = useRef<{ x: number; y: number; width: number; height: number; offset: [number, number] } | null>(null);
  if (!component) return null;
  const label = component.labelTexture;
  const mapping: LabelMapping = label?.mapping || guideMappings[component.id] || defaultLabelMapping(component);
  const material: SurfaceMaterial = { baseColor: [.5, .5, .5, 1], roughness: .5, metallic: 0, ...component.material };
  const imported = component.shape === 'mesh';
  const original = imported && component.materialOverride !== true;
  const editComponent = (edit: (current: any) => void) => onChange(current => {
    const target = current.product.components.find((item: any) => item.id === component.id);
    if (target) edit(target);
  });
  const editMapping = (next: LabelMapping) => {
    if (label) editComponent(current => { if (current.labelTexture) current.labelTexture.mapping = next; });
    else setGuideMappings(previous => ({ ...previous, [component.id]: next }));
  };
  const editSurface = (patch: Partial<SurfaceMaterial>) => editComponent(current => {
    current.material = { ...material, ...patch };
    if (imported) current.materialOverride = true;
  });
  const finish = labelMaterial(label?.material);
  const editLabelMaterial = (patch: Partial<SurfaceMaterial>) => editComponent(current => {
    if (current.labelTexture) current.labelTexture.material = { ...finish, ...patch };
  });
  const [planeW, planeH] = mappingDimensions(component, mapping);
  const planeAspect = planeW / planeH;
  const upload = async (file: File) => {
    if (!uploadAvailable || busy) return;
    const invalid = labelUploadError(file);
    if (invalid) { setError(invalid); return; }
    setError(''); setBusy(true);
    try {
      const asset = await onUpload(file);
      if (!mounted.current) return;
      const nextMapping = label ? mapping : fitLabelMapping(component, asset, mapping);
      editComponent(current => { current.labelTexture = { asset, mapping: nextMapping, material: { ...finish } }; });
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not upload this image. Try again.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="control-section label-material-panel" aria-label="Labels and materials">
    <div className="section-label"><span>LABELS & MATERIALS</span></div>
    <Field label="Product part"><select aria-label="Label and material part" disabled={busy} value={component.id} onChange={event => { onSelect(event.target.value); setError(''); }}>
      {scene.product.components.map((item: any) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
    </select></Field>
    <div className="label-editor-group" aria-label="Label artwork">
      <h3>Label artwork</h3>
      <p className="small-copy">Add your label as PNG or JPEG. Transparent PNG keeps the product surface visible around the artwork.</p>
      <label className="field"><span>{label ? 'Replace artwork' : 'Upload artwork'}</span><input aria-label="Label artwork file" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" disabled={busy || !uploadAvailable}
        aria-disabled={busy || !uploadAvailable} aria-describedby={!uploadAvailable ? `${tintFilterId}-upload-status` : undefined}
        onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }}/></label>
      {!uploadAvailable && <p className="small-copy" role="status" id={`${tintFilterId}-upload-status`}>Image uploads need a connected backend. Try the sample artwork and placement controls.</p>}
      {busy && <p className="small-copy" role="status">Uploading artwork…</p>}
      {error && <p className="message error" role="alert">{error}</p>}
      <Field label="Map artwork onto"><select aria-label="Artwork mapping" value={mapping.mode} disabled={busy} onChange={event => {
          const next = { ...mapping, mode: event.target.value as LabelMapping['mode'] };
          editMapping(label ? fitLabelMapping(component, label.asset, next) : next);
        }}><option value="planar">Face projection</option><option value="cylindrical">Cylinder wrap</option>{imported && <option value="uv">Existing UVs</option>}</select></Field>
        {mapping.mode === 'planar' && <Field label="Product face"><select aria-label="Product face" value={mapping.face} disabled={busy} onChange={event => {
          const next = { ...mapping, face: event.target.value as LabelMapping['face'] };
          editMapping(label ? fitLabelMapping(component, label.asset, next) : next);
        }}>{(['front', 'back', 'left', 'right', 'top', 'bottom'] as const).map(face => <option key={face} value={face}>{face[0].toUpperCase() + face.slice(1)}</option>)}</select></Field>}
      {label && <fieldset className="label-controls" disabled={busy} aria-label="Artwork placement and finish">
        <svg width="0" height="0" aria-hidden="true" className="label-tint-filter"><defs><filter id={tintFilterId} colorInterpolationFilters="linearRGB"><feComponentTransfer>
          <feFuncR type="linear" slope={finish.baseColor[0]}/><feFuncG type="linear" slope={finish.baseColor[1]}/><feFuncB type="linear" slope={finish.baseColor[2]}/>
        </feComponentTransfer></filter></defs></svg>
        <div className="label-map-stage"><div className="label-map-preview" aria-label="Label placement preview" style={{ width: `${Math.min(100, planeAspect / 1.4 * 100)}%`, aspectRatio: planeAspect }}
          onPointerDown={event => {
            if (event.button !== 0 || busy) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            drag.current = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, offset: [...mapping.offset] };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={event => {
            const start = drag.current;
            if (start) editMapping({ ...mapping, offset: dragLabelOffset(start.offset, event.clientX - start.x, event.clientY - start.y, start.width, start.height) });
          }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
          <span className="label-map-axis label-map-axis-x"/><span className="label-map-axis label-map-axis-y"/>
          <img draggable={false} alt="Your label artwork" src={assetUrl(label.asset.path)} style={{ ...labelPreviewStyle(mapping, planeAspect), opacity: finish.baseColor[3] ?? 1, filter: `url(#${tintFilterId})` }}/>
        </div></div>
        <p className="small-copy">Drag to position. The rectangle shows the mapped area; check the 3D view for the final fit.{mapping.mode === 'uv' ? ' Existing UVs use the mesh’s original layout; seams may split the artwork.' : mapping.mode === 'cylindrical' ? ' Cylinder wrap runs around the vertical axis.' : ''}</p>
        <label className="label-check"><input type="checkbox" checked={aspectLocked} onChange={event => setAspectLocked(event.target.checked)}/>Lock artwork proportions</label>
        <div className="two-col"><Numeric label="Artwork width (%)" value={mapping.scale[0] * 100} min={1} max={1000} onChange={value => editMapping(resizeLabel(mapping, 0, value / 100, aspectLocked))}/>
          <Numeric label="Artwork height (%)" value={mapping.scale[1] * 100} min={1} max={1000} onChange={value => editMapping(resizeLabel(mapping, 1, value / 100, aspectLocked))}/></div>
        <div className="two-col"><Numeric label="Position X (%)" value={mapping.offset[0] * 100} min={-500} max={500} onChange={value => editMapping({ ...mapping, offset: [value / 100, mapping.offset[1]] })}/>
          <Numeric label="Position Y (%)" value={mapping.offset[1] * 100} min={-500} max={500} onChange={value => editMapping({ ...mapping, offset: [mapping.offset[0], value / 100] })}/></div>
        <Numeric label="Artwork rotation (°)" value={mapping.rotationDegrees} min={-360} max={360} onChange={value => editMapping({ ...mapping, rotationDegrees: value })}/>
        <div className="label-actions"><button type="button" onClick={() => editMapping({ ...mapping, offset: [0, 0] })}>Center artwork</button>
          <button type="button" onClick={() => editMapping(fitLabelMapping(component, label.asset, mapping))}>Reset fit</button></div>
        <h4>Label finish</h4>
        <Field label="Printed label material"><select aria-label="Printed label material" value={finishKey(finish, LABEL_FINISHES)} onChange={event => {
          const preset = LABEL_FINISHES[event.target.value as keyof typeof LABEL_FINISHES];
          if (preset) editLabelMaterial({ roughness: preset.roughness, metallic: preset.metallic });
        }}><option value="custom">Custom label finish</option>{Object.entries(LABEL_FINISHES).map(([key, preset]) => <option key={key} value={key}>{preset.name}</option>)}</select></Field>
        <Color label="Artwork tint" value={finish.baseColor} onChange={baseColor => editLabelMaterial({ baseColor })}/>
        <Slider label="Label opacity" value={finish.baseColor[3] ?? 1} onChange={alpha => editLabelMaterial({ baseColor: [...finish.baseColor.slice(0, 3), alpha] })}/>
        <Slider label="Label roughness" value={finish.roughness} onChange={roughness => editLabelMaterial({ roughness })}/>
        <Slider label="Label metallic" value={finish.metallic} onChange={metallic => editLabelMaterial({ metallic })}/>
        <button type="button" className="text-button label-remove" disabled={busy} onClick={() => editComponent(current => { delete current.labelTexture; })}>Remove artwork</button>
      </fieldset>}
      <button type="button" className="wide" onClick={() => onTemplate(component.id, mapping)}>Download UV guide</button>
      <p className="small-copy">Use the guide in your image editor, then upload the finished artwork.</p>
    </div>
    <div className="label-editor-group" aria-label="Product surface material">
      <h3>Product surface</h3>
      <Field label="Surface finish"><select aria-label="Surface finish" value={original ? 'original' : finishKey(material, SURFACE_FINISHES)} onChange={event => {
        const value = event.target.value;
        if (value === 'original') editComponent(current => { current.materialOverride = false; });
        else {
          const preset = SURFACE_FINISHES[value as keyof typeof SURFACE_FINISHES];
          editSurface(preset ? { roughness: preset.roughness, metallic: preset.metallic, transmission: preset.transmission, ior: preset.ior } : {});
        }
      }}>{imported && <option value="original">Original mesh materials</option>}<option value="custom">Custom material</option>
        {Object.entries(SURFACE_FINISHES).map(([key, preset]) => <option key={key} value={key}>{preset.name}</option>)}</select></Field>
      {original ? <p className="small-copy">Original mesh materials are preserved. Choose a finish to customize this part’s surface. Label artwork is separate.</p> : <>
        <Color label="Surface color" value={material.baseColor} onChange={baseColor => editSurface({ baseColor })}/>
        <Slider label="Surface roughness" value={material.roughness} onChange={roughness => editSurface({ roughness })}/>
        <Slider label="Surface metallic" value={material.metallic} onChange={metallic => editSurface({ metallic })}/>
        <Slider label="Surface transmission" value={material.transmission || 0} onChange={transmission => editSurface({ transmission })}/>
        <Numeric label="Index of refraction" value={material.ior ?? 1.5} min={1} max={3} step={.01} onChange={ior => editSurface({ ior })}/>
        <p className="small-copy">Roughness changes gloss; metallic changes metal response. Transmission lets light through; use a still render to review glass.</p>
        {imported && <button type="button" className="text-button" onClick={() => editComponent(current => { current.materialOverride = false; })}>Restore original mesh materials</button>}
      </>}
    </div>
  </section>;
}
