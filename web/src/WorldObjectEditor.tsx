import {useLayoutEffect, useRef, type ReactNode} from 'react';
import {Euler, Quaternion} from 'three';
import {NumberControl, VectorControl} from './EditorControls';
import {colorFromHex, colorHex, PLINTH_MATERIAL, resizeProp, setPropShape} from './world';
import {canPropSupportProduct, objectName, relationLabels, relationshipTargets, removeSceneProp, setPlinthShown, setPropRelationship, usePropAsSupport, type RelationType, type ResolvedObjects} from './sceneGraph';
import './world-objects.css';
function Field({label, children}: {label: string; children: ReactNode}) {return <label className="gesso-field"><span>{label}</span>{children}</label>;}
const NumberField = NumberControl;
function VectorField({label, values, onChange, factor = 1, min}: {label: string; values: number[]; onChange: (index: number, value: number) => void; factor?: number; min?: number}) {
  const split = label.split(' · ');
  return <VectorControl label={split[0]} values={values} factor={factor} min={min} step={factor === 1 ? .01 : 1} unit={split[1] === 'degrees' ? '°' : split[1]} onChange={onChange}/>;
}
function ColorField({label, value, onChange}: {label: string; value: number[]; onChange: (color: number[]) => void}) {
  return <Field label={label}><div className="gesso-color"><input type="color" aria-label={label} value={colorHex(value)} onChange={event => onChange(colorFromHex(event.target.value))}/><span>{colorHex(value).toUpperCase()}</span></div></Field>;
}

export interface WorldObjectEditorProps {
  scene: any;
  objectId: string;
  onChange: (edit: (scene: any) => void) => void;
  onClose: (removed?: boolean) => void;
  onFrameProp?: (id: string) => void;
  /** Resolved poses, so detaching or freeing a related object keeps it in place. */
  resolved?: ResolvedObjects;
}

/** Edits the same scene object used by the viewport and its library preview. */
export default function WorldObjectEditor({scene, objectId, onChange, onClose, onFrameProp, resolved}: WorldObjectEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (document.activeElement?.matches('.gesso-world-object-previews button:focus-visible, .gesso-world-object-actions button:focus-visible')) {
      editorRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    }
  }, [objectId]);
  const environment = scene.environment;
  const isPlinth = objectId === environment.plinth.id;
  const prop = isPlinth ? environment.plinth : environment.props?.find((item: any) => item.id === objectId);
  if (!prop) return null;
  const name = isPlinth ? 'Plinth' : prop.displayName ?? prop.id;
  const editProp = (edit: (value: any) => void) => onChange(next => {
    const target = isPlinth ? next.environment.plinth : next.environment.props?.find((item: any) => item.id === objectId);
    if (target) edit(target);
  });
  const surface = prop.material ?? PLINTH_MATERIAL;
  const relationship = isPlinth ? undefined : prop.relationship;
  const restsOnThis = scene.placement.restsOn === objectId;
  const changeRelationship = (type: RelationType | 'free', targetId?: string) => onChange(next => {
    if (type === 'free') {
      // Freeing keeps the object where the relationship had placed it.
      const target = next.environment.props?.find((item: any) => item.id === objectId);
      const position = resolved?.props?.[objectId]?.translationM;
      if (target && position) target.translationM = [...position];
    }
    setPropRelationship(next, objectId, type, targetId);
  });
  const editMaterial = (edit: (value: any) => void) => editProp(target => {target.material ??= structuredClone(PLINTH_MATERIAL); edit(target.material);});
  return <div ref={editorRef} id="world-object-settings" className="gesso-panel gesso-world-object-editor" onKeyDown={event => {
    if (event.key === 'Escape' && !(event.target as HTMLElement).matches('input,select,textarea')) {
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  }}>
    <header className="gesso-world-object-heading">
      <div><span>Object settings</span><h2>{name}</h2></div>
      <button type="button" className="gesso-text-button" onClick={() => onClose()} aria-label="Close object settings">Done</button>
    </header>
    <div className="gesso-world-object-body">
      {!isPlinth && <Field label="Name"><input aria-label="Object name" value={prop.displayName ?? prop.id} maxLength={80} onChange={event => {const name = event.target.value; editProp(target => {target.displayName = name;});}}/></Field>}
      <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">{isPlinth ? 'Plinth' : 'Geometry'}</span></div>
        {isPlinth && <label className="gesso-check"><input type="checkbox" checked={prop.visible !== false} onChange={event => {const visible = event.target.checked; onChange(next => setPlinthShown(next, visible, resolved));}}/><span>Show plinth</span></label>}
        {!isPlinth && <>
          {prop.shape === 'mesh' ? <p className="gesso-meta">Imported mesh · {prop.materialOverride ? 'material override' : 'original UVs and materials'}</p> : <Field label="Shape"><select value={prop.shape} onChange={event => {const shape = event.target.value as 'box' | 'cylinder'; editProp(target => setPropShape(target, shape));}}><option value="box">Box</option><option value="cylinder">Cylinder</option></select></Field>}</>}
        <VectorField label="Size · mm" values={prop.sizeM} min={1} factor={1000} onChange={(axis, value) => editProp(target => resizeProp(target, axis, value))}/>
        {prop.shape === 'mesh' && <p className="gesso-meta">Source {(prop.asset.sourceDimensionsM ?? prop.sizeM).map((value: number) => Number((value * 1000).toFixed(1))).join(' × ')} mm. Size changes this instance.</p>}
        {relationship ? <p className="gesso-meta">Position follows {objectName(scene, relationship.targetId)}.</p>
          : <VectorField label="Position · mm" values={prop.translationM} factor={1000} onChange={(axis, value) => editProp(target => {target.translationM[axis] = value;})}/>}
        {isPlinth ? <p className="gesso-meta">{!restsOnThis ? `The product rests on ${scene.placement.restsOn === 'floor' ? 'the floor' : scene.placement.restsOn === 'world-surface' ? 'a picked world surface' : objectName(scene, scene.placement.restsOn)}.` : prop.visible === false ? 'Hidden. Product placement still follows this contact surface.' : 'The product follows the top of this contact surface.'}</p> : <>
          <VectorField label="Rotation · degrees" factor={180 / Math.PI} values={new Euler().setFromQuaternion(new Quaternion().fromArray(prop.rotationXyzw), 'XYZ').toArray().slice(0, 3) as number[]} onChange={(axis, value) => editProp(target => {
            const rotation = new Euler().setFromQuaternion(new Quaternion().fromArray(target.rotationXyzw), 'XYZ');
            if (axis === 0) rotation.x = value; else if (axis === 1) rotation.y = value; else rotation.z = value;
            target.rotationXyzw = new Quaternion().setFromEuler(rotation).toArray();
          })}/>
          {prop.shape !== 'mesh' && <NumberField label="Edge radius" unit="mm" value={(prop.bevelM ?? 0) * 1000} min={0} max={Math.min(...prop.sizeM) * 500} step={.1} onChange={value => editProp(target => {target.bevelM = value / 1000;})}/>}
          {prop.shape === 'cylinder' && <p className="gesso-meta">X and Z share the same diameter.</p>}
        </>}
      </section>
      {!isPlinth && <section className="gesso-section" aria-label="Object relationship"><div className="gesso-section-heading"><span className="gesso-section-label">Relationship</span></div>
        <Field label="Placement"><select aria-label="Interaction" value={relationship?.type ?? 'free'} onChange={event => changeRelationship(event.target.value as RelationType | 'free', relationship?.targetId ?? 'product')}>
          <option value="free">Free placement</option>
          {Object.entries(relationLabels).map(([type, label]) => <option key={type} value={type} disabled={!relationshipTargets(scene, objectId, type as RelationType).length}>{label}</option>)}
        </select></Field>
        {relationship && <>
          <Field label="Relative to"><select aria-label="Relative to" value={relationship.targetId} onChange={event => changeRelationship(relationship.type, event.target.value)}>
            {relationshipTargets(scene, objectId, relationship.type).map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
          </select></Field>
          <NumberField label="Gap" unit="mm" value={(relationship.gapM ?? 0) * 1000} min={0} step={1} onChange={value => editProp(target => {target.relationship.gapM = value / 1000;})}/>
          <VectorField label="Offset · mm" values={relationship.offsetM ?? [0, 0, 0]} factor={1000} onChange={(axis, value) => editProp(target => {(target.relationship.offsetM ??= [0, 0, 0])[axis] = value;})}/>
        </>}
        <button type="button" disabled={restsOnThis || !canPropSupportProduct(prop)} title={!canPropSupportProduct(prop) ? 'A support needs a visible, level top surface.' : undefined}
          onClick={() => onChange(next => {usePropAsSupport(next, objectId, resolved);})}>{restsOnThis ? 'Product rests on this object' : 'Rest product on this object'}</button>
      </section>}
      <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">Surface</span></div>
        {prop.shape === 'mesh' && <label className="gesso-check"><input type="checkbox" checked={prop.materialOverride === true} onChange={event => {const enabled = event.target.checked; editProp(target => {target.materialOverride = enabled;});}}/><span>Override source materials</span></label>}
        {(prop.shape !== 'mesh' || prop.materialOverride === true) && <>
        <ColorField label="Color" value={surface.baseColor} onChange={color => editMaterial(target => {target.baseColor = [...color, target.baseColor[3]];})}/>
        <NumberField label="Roughness" unit="%" step={1} value={surface.roughness * 100} min={0} max={100} onChange={value => editMaterial(target => {target.roughness = value / 100;})}/>
        <NumberField label="Metalness" unit="%" step={1} value={surface.metallic * 100} min={0} max={100} onChange={value => editMaterial(target => {target.metallic = value / 100;})}/></>}
        {prop.source?.url && <p className="gesso-meta"><a href={prop.source.url} target="_blank" rel="noreferrer">{prop.displayName} · Poly Haven ↗</a> · CC0</p>}
      </section>
    </div>
    {!isPlinth && <footer className="gesso-world-object-footer">
      {!isPlinth && onFrameProp && <button type="button" onClick={() => onFrameProp(prop.id)}>Frame object</button>}
      {!isPlinth && <button type="button" onClick={() => {onClose(true); onChange(next => removeSceneProp(next, prop.id, resolved));}}>Remove object</button>}
    </footer>}
  </div>;
}
