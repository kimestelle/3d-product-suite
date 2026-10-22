import {EditorCabinetBody} from './editorMotion';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import WorldObjectPreviews from './WorldObjectPreviews';
import WorldObjectEditor from './WorldObjectEditor';
import {useWorldCovers, WorldCoverImage, type CurrentWorldCapture} from './WorldCovers';
import {worldCoverKey, type WorldCoverItem} from './worldCover';
import './world-objects.css';
import {NumberControl, VectorControl} from './EditorControls';
import {formatScalePercent} from './transforms';
import {matchWorldRevision} from './comparison';
import PolyHavenLibrary from './PolyHavenLibrary';
import {addLight, addProp, addPropFromLibrary, applyDramaticSpot, setHdriFromLibrary, colorFromHex, colorHex, defaultLighting, ensureLighting, lightType, removeLight, setLightType, setWorldYaw, worldYaw, SPOT_DEFAULTS, type StudioLightType} from './world';
import {objectName, productSupportTargets, relationLabels, sceneFloorY, setProductSupport, type RelationType, type ResolvedObjects} from './sceneGraph';

export type WorldLayer = 'Environment' | 'Props' | 'Lights';
export interface WorldPanelProps extends CurrentWorldCapture {
  scene: any; layer: WorldLayer; worlds: {id: string; name: string; environment: any}[];
  onChange: (edit: (scene: any) => void) => void; onWorld: (id: string) => void; onImport: () => void;
  onFitProduct?: () => void;
  fitDisabled?: boolean;
  onFrameProp?: (id: string) => void;
  selectedObjectId?: string | null;
  onSelectObject?: (id: string | null) => void;
  editorHost?: HTMLElement | null;
  children?: ReactNode;
  /** Resolved scene-object poses from the last evaluation (film/scene_objects.py). */
  resolved?: ResolvedObjects;
  pickingSurface?: boolean;
  onPickSurface?: () => void;
  onCancelPick?: () => void;
  onFrameObjects?: () => void;
  ready?: boolean;
}
function Field({label, children}: {label: string; children: ReactNode}) {return <label className="gesso-field"><span>{label}</span>{children}</label>;}
const NumberField = NumberControl;
function VectorField({label, values, onChange, factor = 1, min}: {label: string; values: number[]; onChange: (index: number, value: number) => void; factor?: number; min?: number}) {
  const split = label.split(' · ');
  return <VectorControl label={split[0]} values={values} factor={factor} min={min} step={factor === 1 ? .01 : 1} unit={split[1] === 'degrees' ? '°' : split[1]} onChange={onChange}/>;
}
function ColorField({label, value, onChange}: {label: string; value: number[]; onChange: (color: number[]) => void}) {
  return <Field label={label}><div className="gesso-color"><input type="color" aria-label={label} value={colorHex(value)} onChange={event => onChange(colorFromHex(event.target.value))}/><span>{colorHex(value).toUpperCase()}</span></div></Field>;
}

/** Where the product rests, shared by the browser and Cycles (D160). */
function ProductPlacement({scene, onChange, pickingSurface = false, onPickSurface, onCancelPick, onFrameObjects, ready = true}: Pick<WorldPanelProps, 'scene' | 'onChange' | 'pickingSurface' | 'onPickSurface' | 'onCancelPick' | 'onFrameObjects' | 'ready'>) {
  const placement = scene.placement;
  const targets = productSupportTargets(scene);
  // A hidden contact plinth (D93) is not offered as a new support, but stays selectable while in use.
  if (!targets.some(target => target.id === placement.restsOn)) targets.push({id: placement.restsOn, label: placement.restsOn === scene.environment.plinth.id ? 'Plinth (hidden)' : objectName(scene, placement.restsOn)});
  const plinthSupport = placement.restsOn === scene.environment.plinth.id;
  return <section className="gesso-section gesso-product-placement" aria-label="Product placement"><div className="gesso-section-heading"><span className="gesso-section-label">Product placement</span></div>
    <Field label="Rests on"><select aria-label="Rest product on" value={placement.restsOn} onChange={event => {const id = event.target.value; onChange(next => setProductSupport(next, id));}}>
      {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
    </select></Field>
    {scene.environment.kind === 'mesh' && <button type="button" aria-pressed={pickingSurface} disabled={!ready && !pickingSurface} onClick={pickingSurface ? onCancelPick : onPickSurface}>{pickingSurface ? 'Cancel surface pick' : 'Pick a surface in the world'}</button>}
    {placement.restsOn === 'world-surface' && <p className="gesso-meta gesso-note">Re-pick the surface after replacing or realigning the world.</p>}
    {scene.environment.kind === 'splat' && <p className="gesso-meta gesso-note">Surface picking needs a mesh world. Rest the product on the floor or an object.</p>}
    <VectorField label="Offset · mm" values={placement.translationM} factor={1000} onChange={(axis, value) => onChange(next => {next.placement.translationM[axis] = value;})}/>
    <NumberField label="Turn" unit="°" ariaLabel="Product rotation" value={placement.rotationYDegrees ?? 0} min={-360} max={360} step={1} onChange={value => onChange(next => {if (value) next.placement.rotationYDegrees = value; else delete next.placement.rotationYDegrees;})}/>
    <NumberField label="Floor" unit="mm" ariaLabel="Floor height" value={sceneFloorY(scene) * 1000} step={1} onChange={value => onChange(next => {next.environment.floorY = value / 1000;})}/>
    <p className="gesso-meta gesso-note">{plinthSupport && scene.environment.plinth.visible === false ? 'The hidden plinth is the floor at the product’s contact.' : 'Objects on the floor follow its height.'}</p>
    {onFrameObjects && <button type="button" disabled={!ready} onClick={onFrameObjects}>Frame product and objects</button>}
  </section>;
}

export default function WorldPanel({scene, layer, worlds, onChange, onWorld, onImport, onFitProduct, fitDisabled, onFrameProp, selectedObjectId = null, onSelectObject, editorHost, children, captureCurrentWorld, worldPreviewReady, worldPreviewRevision, resolved, pickingSurface, onPickSurface, onCancelPick, onFrameObjects, ready}: WorldPanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const [selectedLight, setSelectedLight] = useState('key');
  const [addLightOpen, setAddLightOpen] = useState(false);
  useEffect(() => {setSelectedLight('key'); setAddLightOpen(false);}, [scene.sceneId]);
  const environment = scene.environment;
  const matchedWorld = matchWorldRevision(worlds, environment);
  const currentWorld: WorldCoverItem = {
    id: environment.kind === 'authored' ? 'authored' : matchedWorld?.id ?? 'current',
    name: environment.kind === 'authored' ? 'Authored studio' : matchedWorld?.name ?? environment.displayName ?? 'Saved custom world',
    environment, productDimensionsM: scene.product.dimensionsM,
  };
  const worldItems: WorldCoverItem[] = [
    {id: 'authored', name: 'Authored studio', environment: {kind: 'authored', worldColor: environment.worldColor, plinth: environment.plinth, props: environment.props}},
    // Changing the world retains the project's shared contact surface and props.
    ...worlds.map(world => ({...world, environment: {...world.environment, plinth: environment.plinth, props: environment.props}})),
    ...(currentWorld.id === 'current' ? [currentWorld] : []),
  ].map(item => item.id === currentWorld.id ? currentWorld : {...item, productDimensionsM: scene.product.dimensionsM});
  const {covers, observe} = useWorldCovers(worldItems, currentWorld, {captureCurrentWorld, worldPreviewReady, worldPreviewRevision});
  const lighting = scene.lighting ?? defaultLighting(scene);
  const light = lighting.lights.find((item: any) => item.id === selectedLight) ?? lighting.lights[0];
  const editLight = (edit: (value: any) => void) => onChange(next => {const target = ensureLighting(next).lights.find(item => item.id === light.id); if (target) edit(target);});
  const objects = [environment.plinth, ...(environment.props ?? [])].map((object: any) => {
    const isPlinth = object.id === environment.plinth.id;
    const kind = isPlinth ? 'Contact surface' : object.shape === 'mesh' ? 'Imported mesh' : object.shape === 'cylinder' ? 'Cylinder' : 'Box';
    const dimensions = object.sizeM.map((value: number) => Number((value * 1000).toFixed(1))).join(' × ');
    const relation = object.relationship ? ` · ${relationLabels[object.relationship.type as RelationType] ?? object.relationship.type} ${objectName(scene, object.relationship.targetId)}` : '';
    return {id: object.id, name: isPlinth ? 'Plinth' : object.displayName ?? object.id, object, isPlinth,
      description: `${kind}${object.visible === false ? ' · Hidden' : ''}${relation} · ${dimensions} mm`};
  });
  const closeEditor = (removed = false) => {
    // Return keyboard users to the object they were editing before collapsing the rail.
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.gesso-world-object-previews button');
    const button = removed ? root.current?.querySelector<HTMLButtonElement>('.gesso-world-object-actions button')
      : Array.from(buttons ?? []).find(button => button.dataset.objectId === selectedObjectId);
    button?.focus();
    onSelectObject?.(null);
  };
  const editor = layer === 'Props' && selectedObjectId && objects.some(item => item.id === selectedObjectId)
    ? <WorldObjectEditor scene={scene} objectId={selectedObjectId} onChange={onChange} onClose={closeEditor} onFrameProp={onFrameProp} resolved={resolved}/> : null;

  return <div ref={root} className="gesso-panel gesso-condensed-world gesso-control-sections">
    {editorHost && editor ? createPortal(editor, editorHost) : editor}
    <figure className="gesso-selected-world-cover" aria-label="Current stage preview">
      <WorldCoverImage name={currentWorld.name} cover={covers[worldCoverKey(environment, scene.product.dimensionsM)]} selected/>
      <figcaption><span>{currentWorld.name}</span><small>Scene preview</small></figcaption>
    </figure>
    <section className="gesso-control-section gesso-stage-controls is-open" key={layer} aria-label={`${layer==='Props'?'Objects':layer==='Lights'?'Lighting':layer} controls`}>
      <EditorCabinetBody open id={`world-section-${layer}`}>
      {layer==='Environment' && <>
      {!scene.comparison && <>
        <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">Surroundings</span></div>
          <div className="gesso-world-cover-library gesso-selection-surface" role="group" aria-label="World library">
            {worldItems.map(world => <button key={world.id} ref={element => observe(world.id, element)} type="button"
              className="gesso-world-cover-card" data-world-id={world.id} aria-label={`Use ${world.name}`}
              aria-pressed={currentWorld.id === world.id} onClick={() => {if (world.id !== currentWorld.id) onWorld(world.id);}}>
              <WorldCoverImage name={world.name} cover={covers[worldCoverKey(world.environment, world.productDimensionsM)]}/><span>{world.name}</span>
            </button>)}
          </div>
          <p className="gesso-meta">{environment.kind === 'authored' ? environment.plinth.visible === false ? 'Curved sweep' : 'Curved sweep + contact plinth' : environment.kind === 'splat' ? 'Gaussian world · camera-matched plate' : 'Imported mesh · native geometry'}</p>
          <button type="button" onClick={onImport}>Import world ↗</button>
        </section>
        {environment.asset && <details className="gesso-disclosure gesso-compact-details"><summary>Alignment <span>{Number(environment.asset.scaleToMeters.toPrecision(4))} m/u</span></summary><section className="gesso-section">
          <NumberField label="Scale" unit="m/u" ariaLabel="Meters per source unit" value={environment.asset.scaleToMeters} min={.00001} step={.01} onChange={value => onChange(next => {next.environment.asset.scaleToMeters = value;})}/>
          <VectorField label="Position · m" values={environment.asset.translationM} onChange={(axis, value) => onChange(next => {next.environment.asset.translationM[axis] = value;})}/>
          <NumberField label="Yaw" unit="°" value={worldYaw(environment.asset)} step={1} onChange={value => onChange(next => setWorldYaw(next.environment.asset, value))}/>
          <p className="gesso-meta gesso-note">Moves the imported world. Product and props keep their positions.</p>
        </section></details>}
      </>}
      {environment.asset && onFitProduct && <section className="gesso-section">
        <div className="product-fit-controls"><button type="button" disabled={fitDisabled} onClick={onFitProduct}>Fit product to scene</button>
          <span className="gesso-meta">{formatScalePercent(scene.placement.scale ?? 1)}%</span></div>
        <p className="gesso-meta gesso-note">Fits the product inside the shot. Proportions and source dimensions stay unchanged.</p>
      </section>}
      <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">Background</span></div><ColorField label="World color" value={environment.worldColor} onChange={color => onChange(next => {next.environment.worldColor = color;})}/>
        <p className="gesso-meta gesso-note">Visible beyond the world geometry. Also colors ambient light in the final render.</p>
      </section>
      {children}
      </>}
      {layer==='Props' && <>
      <div className="gesso-world-object-actions">
        <div className="gesso-button-row">{(['box', 'cylinder'] as const).map(shape => <button key={shape} type="button" onClick={() => {const id = addProp(structuredClone(scene), shape); onChange(next => {addProp(next, shape);}); onSelectObject?.(id);}}>Add {shape}</button>)}</div>
        <details className="gesso-disclosure"><summary>Prop library</summary><PolyHavenLibrary kind="models" scopeKey={scene.sceneId} onImport={result => {const id = addPropFromLibrary(structuredClone(scene), result.entry); onChange(next => {addPropFromLibrary(next, result.entry);}); onSelectObject?.(id);}}/></details>
      </div>
      <WorldObjectPreviews items={objects} selectedId={selectedObjectId ?? undefined} onSelect={id => onSelectObject?.(id)}/>
      <ProductPlacement scene={scene} onChange={onChange} pickingSurface={pickingSurface} onPickSurface={onPickSurface} onCancelPick={onCancelPick} onFrameObjects={onFrameObjects} ready={ready}/>
      </>}
      {layer==='Lights' && <>
      <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">Environment light</span></div>
        {lighting.hdri && <>
          <p className="gesso-meta">{lighting.hdri.name}</p>
          <NumberField label="Intensity" value={lighting.hdri.intensity} min={0} max={10} step={.1} onChange={value => onChange(next => {ensureLighting(next).hdri!.intensity = value;})}/>
          <NumberField label="Rotation" unit="°" value={lighting.hdri.rotationDeg} min={-180} max={180} step={1} onChange={value => onChange(next => {ensureLighting(next).hdri!.rotationDeg = value;})}/>
          <p className="gesso-meta"><a href={lighting.hdri.sourceUrl} target="_blank" rel="noreferrer">Poly Haven ↗</a> · CC0</p>
          <button type="button" onClick={() => onChange(next => {delete ensureLighting(next).hdri;})}>Remove environment light</button>
        </>}
        <details className="gesso-disclosure"><summary>HDRI library</summary><PolyHavenLibrary kind="hdris" scopeKey={scene.sceneId} onImport={result => onChange(next => setHdriFromLibrary(next, result.entry))}/></details>
        <p className="gesso-meta gesso-note">HDRI lights the scene and appears in reflections. The background keeps its current color.</p>
      </section>
      <section className="gesso-section"><div className="gesso-section-heading gesso-section-toolbar"><span className="gesso-section-label">Studio rig</span>
          <button type="button" aria-haspopup="true" aria-expanded={addLightOpen} onClick={() => setAddLightOpen(open => !open)}>Add light ▾</button></div>
        {addLightOpen && <div className="gesso-button-row" role="group" aria-label="Add light">{(['area', 'spot'] as const).map(type => <button key={type} type="button" disabled={lighting.lights.length >= 8}
          onClick={() => {const id = addLight(structuredClone(scene), type); onChange(next => {addLight(next, type);}); setSelectedLight(id); setAddLightOpen(false);}}>{type === 'spot' ? 'Spot' : 'Area'}</button>)}</div>}
        <ul className="gesso-part-tree gesso-selection-surface" aria-label="Studio lights">{lighting.lights.map((item: any) => <li key={item.id} className={`gesso-part-row ${light?.id === item.id ? 'selected' : ''}`}>
          <button type="button" className="gesso-part-select" aria-pressed={light?.id === item.id} onClick={() => setSelectedLight(item.id)}><span className="gesso-part-name">{item.name}</span><span className="gesso-status">{lightType(item) === 'spot' ? 'Spot' : 'Area'} · {item.enabled ? 'On' : 'Off'}</span></button>
        </li>)}</ul>
      </section>
      {light && <>
        <section className="gesso-section"><div className="gesso-section-heading">{light.name}</div>
          <label className="gesso-check"><input type="checkbox" checked={light.enabled} onChange={event => {const enabled = event.target.checked; editLight(target => {target.enabled = enabled;});}}/><span>Enabled</span></label>
          <Field label="Type"><select aria-label="Light type" value={lightType(light)} onChange={event => {const type = event.target.value as StudioLightType; editLight(target => setLightType(target, type));}}>
            <option value="area">Area disk</option><option value="spot">Spot</option>
          </select></Field>
          <NumberField label="Power" unit="W" value={light.powerW} min={0} max={100000} step={.1} onChange={value => editLight(target => {target.powerW = value;})}/>
          <ColorField label="Light color" value={light.color} onChange={color => editLight(target => {target.color = color;})}/>
          <NumberField label="Diameter" unit="mm" value={light.diameterM * 1000} min={1} max={1000000} step={5} onChange={value => editLight(target => {target.diameterM = value / 1000;})}/>
          {lightType(light) === 'spot' && <>
            <NumberField label="Cone" unit="°" value={light.coneDeg ?? SPOT_DEFAULTS.coneDeg} min={1} max={170} step={1} onChange={value => editLight(target => {target.coneDeg = value;})}/>
            <NumberField label="Blend" value={light.blend ?? SPOT_DEFAULTS.blend} min={0} max={1} step={.05} onChange={value => editLight(target => {target.blend = value;})}/>
            <p className="gesso-meta gesso-note">A small diameter keeps the shadow hard; blend softens the cone edge.</p>
          </>}
        </section>
        <section className="gesso-section">
          <VectorField label="Position · m" values={light.positionM} onChange={(axis, value) => editLight(target => {target.positionM[axis] = value; if (target.positionM.every((item: number, index: number) => Math.abs(item - target.targetM[index]) < .00001)) target.positionM[axis] += .001;})}/>
          <VectorField label="Aim at · m" values={light.targetM} onChange={(axis, value) => editLight(target => {target.targetM[axis] = value; if (target.positionM.every((item: number, index: number) => Math.abs(item - target.targetM[index]) < .00001)) target.targetM[axis] += .001;})}/>
          <button type="button" disabled={lighting.lights.length <= 1 && !lighting.hdri} onClick={() => {const id = light.id; const remaining = lighting.lights.find((item: any) => item.id !== id)?.id ?? 'key'; onChange(next => {removeLight(next, id);}); setSelectedLight(remaining);}}>Remove light</button>
        </section>
      </>}
      <section className="gesso-section"><div className="gesso-section-heading"><span className="gesso-section-label">Ambient</span></div>
        <NumberField label="Ambient" value={lighting.ambientStrength} min={0} max={3} step={.05} onChange={value => onChange(next => {ensureLighting(next).ambientStrength = value;})}/>
        <ColorField label="Ambient color" value={lighting.ambientColor ?? environment.worldColor} onChange={color => onChange(next => {ensureLighting(next).ambientColor = color;})}/>
        {lighting.ambientColor && <button type="button" onClick={() => onChange(next => {delete ensureLighting(next).ambientColor;})}>Use world color</button>}
        <div className="gesso-button-row">
          <button type="button" onClick={() => onChange(next => {applyDramaticSpot(next);})}>Dramatic spot</button>
          <button type="button" onClick={() => onChange(next => {const hdri = next.lighting?.hdri; next.lighting = defaultLighting(next); if (hdri) next.lighting.hdri = hdri;})}>Reset studio rig</button>
        </div>
        <p className="gesso-meta gesso-note">Preview approximates area lights. Spots cast real shadows in both. Cycles renders the saved power, diameter and position. Baked light in an imported world stays in its source texture.</p>
      </section>
      </>}
      </EditorCabinetBody>
    </section>
  </div>;
}
