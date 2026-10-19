import {useId, type ReactNode} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import type {MaterialSpecification} from './materials';

export type MaterialPropertySection = 'surface' | 'response' | 'maps';
export interface MaterialPropertiesProps {
  material: MaterialSpecification;
  onChange: (next: MaterialSpecification) => void;
  disabled?: boolean;
  activeSection: MaterialPropertySection | null;
  onSectionChange: (section: MaterialPropertySection | null) => void;
}

function Field({label, children}: {label: string; children: ReactNode}) {
  return <label className="gesso-field gesso-material-field"><span>{label}</span>{children}</label>;
}

// Preserve the editor's existing numeric color convention.
const toHex = (value: number[]) => '#' + value.slice(0, 3).map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (value: string) => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);

/** Edits a material draft without owning its scene assignment or persistence. */
export default function MaterialProperties({material, onChange, disabled = false, activeSection, onSectionChange}: MaterialPropertiesProps) {
  const id = useId();
  const update = (patch: Partial<MaterialSpecification>) => {
    if (!disabled) onChange({...structuredClone(material), ...patch});
  };
  const textures = Object.entries(material.textures ?? {}).filter(([, asset]) => !!asset);
  const section = (name: MaterialPropertySection, label: string, summary: string, children: ReactNode) => {
    const open = activeSection === name;
    return <section className={`gesso-material-property-section${open ? ' is-open' : ''}`}>
      <button className="gesso-section-toggle" type="button" aria-expanded={open} aria-controls={`${id}-${name}`} onClick={() => onSectionChange(open ? null : name)}>
        <span>{label}</span><small>{summary}</small><UiIcon name={open ? 'down' : 'chevron'} size={14}/>
      </button>
      <div className="gesso-material-property-body" id={`${id}-${name}`} hidden={!open} inert={!open} aria-hidden={!open}>{children}</div>
    </section>;
  };
  return <fieldset className="gesso-panel gesso-material-properties" disabled={disabled}>
    {section('surface', 'Surface', 'Color / opacity', <>
      <Field label="Color"><div className="gesso-color"><input type="color" aria-label="Material color" value={toHex(material.baseColor)} onChange={event => {
        const [red, green, blue] = fromHex(event.target.value);
        update({baseColor: [red, green, blue, material.baseColor[3]]});
      }}/><span>{toHex(material.baseColor).toUpperCase()}</span></div></Field>
      <NumberControl label="Opacity" unit="%" value={material.baseColor[3] * 100} min={0} max={100} step={1} onChange={value => update({baseColor: [material.baseColor[0], material.baseColor[1], material.baseColor[2], value / 100]})}/>
    </>)}
    {section('response', 'Response', '', <>
      <NumberControl label="Roughness" unit="%" value={material.roughness * 100} min={0} max={100} step={1} onChange={value => update({roughness: value / 100})}/>
      <NumberControl label="Metalness" unit="%" value={material.metallic * 100} min={0} max={100} step={1} onChange={value => update({metallic: value / 100})}/>
      <NumberControl label="Transmission" unit="%" value={(material.transmission ?? 0) * 100} min={0} max={100} step={1} onChange={value => update({transmission: value / 100})}/>
      <NumberControl label="IOR" value={material.ior ?? 1.45} min={1} max={3} step={.01} onChange={value => update({ior: value})}/>
    </>)}
    {section('maps', 'Maps', textures.length ? `${textures.length} linked` : 'None', textures.length ? <>
      <div className="gesso-material-maps">{textures.map(([name, asset]) => <a key={name} href={`/api/assets/${asset.path.split('/').pop()}`} target="_blank" rel="noreferrer">{name === 'basecolor' ? 'Color' : name[0].toUpperCase() + name.slice(1)} ↗</a>)}</div>
      <NumberControl label="Repeat U" value={material.textureRepeat?.[0] ?? 1} min={.01} max={100} step={.1} onChange={value => update({textureRepeat: [value, material.textureRepeat?.[1] ?? 1]})}/>
      <NumberControl label="Repeat V" value={material.textureRepeat?.[1] ?? 1} min={.01} max={100} step={.1} onChange={value => update({textureRepeat: [material.textureRepeat?.[0] ?? 1, value]})}/>
      {material.textures?.normal && <NumberControl label="Normal" unit="%" value={(material.normalScale ?? 1) * 100} min={0} max={200} step={5} onChange={value => update({normalScale: value / 100})}/>}
      {material.textures?.height && !material.textures.normal && <NumberControl label="Bump height" unit="mm" value={(material.heightScaleM ?? 0) * 1000} min={0} max={10} step={.1} onChange={value => update({heightScaleM: value / 1000})}/>}
      <p className="gesso-meta">Uses this part’s UVs. Normal and height maps describe surface detail; the silhouette stays fixed.</p>
    </> : <p className="gesso-meta">No texture maps. Add one from the texture library.</p>)}
  </fieldset>;
}
