import type { ReactNode } from 'react';
import { addSceneProp, canPropSupportProduct, isVisible, objectName, productSupportTargets, relationshipTargets, relationLabels,
  removeSceneProp, sceneFloorY, sceneTree, setPlinthVisible, setProductSupport, setPropRelationship, setPropSize,
  usePropAsSupport, yawDegrees, yawQuaternion, type RelationType, type ResolvedObjects, type SceneTreeNode } from './sceneGraph';

type Props = {
  scene: any;
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (edit: (scene: any) => void) => void;
  onPickSurface: () => void;
  pickingSurface: boolean;
  onCancelPick: () => void;
  ready: boolean;
  resolved?: ResolvedObjects;
};
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function NumberField({ label, value, onChange, min, step = .01 }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; step?: number;
}) {
  return <Field label={label}><input type="number" value={Number(value.toFixed(5))} min={min} step={step}
    onChange={event => { const value = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(value) && (min === undefined || value >= min)) onChange(value); }}/></Field>;
}
function VectorFields({ label, value, onChange, min }: {
  label: string; value: number[]; onChange: (axis: number, value: number) => void; min?: number;
}) {
  return <fieldset className="scene-vector"><legend>{label}</legend><div className="three-col">
    {['X', 'Y', 'Z'].map((axis, i) => <NumberField key={axis} label={`${axis} (m)`} value={value[i]} min={min} onChange={value => onChange(i, value)}/>)}</div></fieldset>;
}
function TreeNode({ node, level, selected, onSelect }: { node: SceneTreeNode; level: number; selected: string | null; onSelect: Props['onSelect'] }) {
  const children = node.children?.length ? node.children : null;
  return <li role="treeitem" aria-label={node.label} aria-level={level} aria-selected={selected === node.id}
    aria-expanded={children ? true : undefined}>
    <button type="button" data-tree-id={node.id} className={`scene-tree-item ${selected === node.id ? 'selected' : ''}`}
      onClick={() => onSelect(node.id)}><span className="scene-tree-label"><span aria-hidden="true">{children ? '⌄' : '·'}</span>{node.label}</span>
      {node.detail && <small>{node.detail}</small>}</button>
    {children && <ul role="group">{children.map(child => <TreeNode key={child.id} node={child} level={level + 1} selected={selected} onSelect={onSelect}/>)}</ul>}
  </li>;
}

export default function SceneObjectsPanel({ scene, selected, onSelect, onChange, onPickSurface,
  pickingSurface, onCancelPick, ready, resolved }: Props) {
  const productSelected = selected === 'product-root' || scene.product.components.some((component: any) => component.id === selected)
    || (selected?.startsWith('action:') ?? false);
  const selectedProp = selected?.startsWith('prop:')
    ? (scene.environment.props || []).find((prop: any) => prop.id === selected.slice(5)) : null;
  const plinthSelected = selected === `plinth:${scene.environment.plinth.id}`;
  const plinth = scene.environment.plinth;
  const relationship = selectedProp?.relationship;
  const editProp = (edit: (prop: any) => void) => onChange(current => {
    const prop = current.environment.props.find((prop: any) => prop.id === selectedProp.id);
    if (prop) edit(prop);
  });
  const addProp = (shape: 'box' | 'cylinder') => {
    // addSceneProp uses only the next available ID, so selection can be computed before the history edit.
    const preview = structuredClone(scene);
    const id = addSceneProp(preview, shape);
    onChange(current => { addSceneProp(current, shape); });
    onSelect(`prop:${id}`);
  };
  return <section className="control-section scene-objects-panel" aria-label="Scene objects and interactions">
    <div className="section-label"><span>SCENE OBJECTS</span></div>
    <ul className="scene-tree" role="tree" aria-label="Scene object tree" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-tree-id]')];
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const item = (event.target as HTMLButtonElement).closest('li');
        const button = event.key === 'ArrowRight'
          ? item?.querySelector<HTMLButtonElement>('ul > li > button')
          : item?.parentElement?.closest('li')?.querySelector<HTMLButtonElement>(':scope > button');
        button?.focus();
        return;
      }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      items[next].focus();
    }}>{sceneTree(scene).map(node => <TreeNode key={node.id} node={node} level={1} selected={selected} onSelect={onSelect}/>)}</ul>
    <div className="scene-add-actions"><button type="button" onClick={() => addProp('box')}>＋ Box</button><button type="button" onClick={() => addProp('cylinder')}>＋ Cylinder</button></div>
    {!isVisible(plinth) && <button type="button" className="text-button" onClick={() => {
      onChange(current => setPlinthVisible(current, true)); onSelect(`plinth:${plinth.id}`);
    }}>＋ Add optional plinth</button>}

    {productSelected && <div className="scene-object-inspector" aria-label="Product placement">
      <h3>Product placement</h3>
      <Field label="Rest product on"><select aria-label="Rest product on" value={scene.placement.restsOn} onChange={event => {
        const id = event.target.value; onChange(current => setProductSupport(current, id));
      }}>{productSupportTargets(scene).map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</select></Field>
      {scene.environment.kind === 'mesh' && <button type="button" className="wide" disabled={!ready && !pickingSurface}
        aria-pressed={pickingSurface} onClick={pickingSurface ? onCancelPick : onPickSurface}>
        {pickingSurface ? 'Cancel surface pick' : 'Pick a surface in the world'}</button>}
      {pickingSurface && <p className="small-copy" role="status">Click a surface in the world to place the product there.</p>}
      {scene.placement.restsOn === 'world-surface' && <p className="small-copy">Re-pick the surface after replacing or realigning the world.</p>}
      {scene.environment.kind === 'splat' && <p className="small-copy">Use a mesh world to pick a surface. You can still place the product on the floor or an added object.</p>}
      <VectorFields label="Offset from support" value={scene.placement.translationM}
        onChange={(axis, value) => onChange(current => { current.placement.translationM[axis] = value; })}/>
      <NumberField label="Product rotation (°)" value={scene.placement.rotationYDegrees || 0} step={1}
        onChange={value => onChange(current => { current.placement.rotationYDegrees = value; })}/>
      {selected !== 'product-root' && <button type="button" className="text-button" onClick={() => onSelect('product-root')}>Select entire product</button>}
    </div>}

    {selectedProp && <div className="scene-object-inspector" aria-label="Object interaction">
      <h3>{objectName(scene, selectedProp.id)}</h3>
      <Field label="Object name"><input value={selectedProp.name || selectedProp.id} maxLength={80}
        onChange={event => { const name = event.target.value; editProp(prop => { prop.name = name; }); }}/></Field>
      <VectorFields label={selectedProp.shape === 'cylinder' ? 'Dimensions · X/Z diameter' : 'Dimensions'} value={selectedProp.sizeM} min={.00001}
        onChange={(axis, value) => editProp(prop => setPropSize(prop, axis, value))}/>
      <NumberField label="Object rotation (°)" value={yawDegrees(selectedProp.rotationXyzw)} step={1}
        onChange={value => editProp(prop => { prop.rotationXyzw = yawQuaternion(value); })}/>
      <Field label="Interaction"><select aria-label="Interaction" value={relationship?.type || 'free'} onChange={event => {
        const type = event.target.value as RelationType | 'free';
        onChange(current => {
          if (type === 'free') {
            const prop = current.environment.props.find((prop: any) => prop.id === selectedProp.id);
            const position = resolved?.props?.[prop.id]?.translationM;
            if (position) prop.translationM = [...position];
          }
          setPropRelationship(current, selectedProp.id, type, relationship?.targetId || 'product');
        });
      }}><option value="free">Free placement</option>{Object.entries(relationLabels).map(([type, label]) => <option key={type} value={type} disabled={!relationshipTargets(scene, selectedProp.id, type as RelationType).length}>{label}</option>)}</select></Field>
      {relationship ? <>
        <Field label="Relative to"><select aria-label="Relative to" value={relationship.targetId} onChange={event => {
          const id = event.target.value; onChange(current => setPropRelationship(current, selectedProp.id, relationship.type, id));
        }}>{relationshipTargets(scene, selectedProp.id, relationship.type).map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</select></Field>
        <NumberField label="Gap (m)" value={relationship.gapM ?? 0} min={0}
          onChange={value => editProp(prop => { prop.relationship.gapM = value; })}/>
        <VectorFields label="Offset from relation" value={relationship.offsetM || [0, 0, 0]}
          onChange={(axis, value) => editProp(prop => { (prop.relationship.offsetM ??= [0, 0, 0])[axis] = value; })}/>
        <p className="small-copy">Follows {objectName(scene, relationship.targetId)} when its placement changes.</p>
      </> : <VectorFields label="Position" value={selectedProp.translationM}
        onChange={(axis, value) => editProp(prop => { prop.translationM[axis] = value; })}/>}
      <button type="button" className="wide" disabled={!ready || !canPropSupportProduct(selectedProp)}
        title={!canPropSupportProduct(selectedProp) ? 'Support needs a visible, horizontal top surface.' : undefined}
        onClick={() => onChange(current => { usePropAsSupport(current, selectedProp.id, resolved); })}>
        Rest product on this object</button>
      <button type="button" className="text-button scene-remove" onClick={() => {
        onChange(current => removeSceneProp(current, selectedProp.id, resolved)); onSelect('product-root');
      }}>Remove object</button>
    </div>}

    {plinthSelected && isVisible(plinth) && <div className="scene-object-inspector" aria-label="Plinth placement">
      <h3>Optional plinth</h3>
      <VectorFields label="Plinth dimensions" value={plinth.sizeM} min={.00001}
        onChange={(axis, value) => onChange(current => { current.environment.plinth.sizeM[axis] = value; })}/>
      <VectorFields label="Plinth position" value={plinth.translationM}
        onChange={(axis, value) => onChange(current => { current.environment.plinth.translationM[axis] = value; })}/>
      <button type="button" className="text-button scene-remove" onClick={() => {
        onChange(current => setPlinthVisible(current, false, resolved)); onSelect('product-root');
      }}>Remove plinth</button>
    </div>}
    {selected === 'floor' && <div className="scene-object-inspector" aria-label="Floor placement"><h3>Floor</h3>
      <NumberField label="Floor height (m)" value={sceneFloorY(scene)}
        onChange={value => onChange(current => { current.environment.floorY = value; })}/>
      <p className="small-copy">Objects resting on the floor follow this height.</p>
    </div>}
    {selected === 'world' && <p className="small-copy">{scene.environment.kind === 'mesh'
      ? 'The world is one imported mesh. Pick a surface to place the product on its geometry.'
      : scene.environment.kind === 'splat' ? 'Gaussian world. Add explicit objects for editable product interactions.'
      : 'Studio background. Add objects and choose how they relate to the product.'}</p>}
    <p className="small-copy scene-interaction-note">Link objects to support the product, stack them, or place them around it. Render a still to check contact shadows and occlusion.</p>
  </section>;
}
