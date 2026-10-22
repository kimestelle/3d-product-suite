import {useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {type ImageAsset} from './materials';
import {createMaterialSwatchStore, type SwatchPreviewState} from './materialSwatchStore';
import {UiIcon} from './UiIcon';
import {bindMaterialSampleControls} from './materialSampleControls';
import './material-swatches.css';

export interface MaterialSwatchItem {
  id: string;
  name: string;
  material: any;
  description?: string;
}

export interface MaterialSwatchesProps {
  items: MaterialSwatchItem[];
  selectedId?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  layout?: 'grid' | 'list';
  renderBelow?: (item: MaterialSwatchItem) => ReactNode;
  renderActions?: (item: MaterialSwatchItem) => ReactNode;
  itemProps?: (item: MaterialSwatchItem) => HTMLAttributes<HTMLDivElement>;
  shape?: 'sphere' | 'rectangle' | 'cube';
  rotationControl?: RefObject<HTMLButtonElement | null>;
}

const SPHERE_RADIUS_M = .025;

function textureUrl(asset: ImageAsset) {
  const filename = asset.path.split('/').pop() ?? '';
  if (!/^[a-f0-9]{64}\.png$/.test(filename)) throw new Error('Invalid texture asset');
  return `/api/assets/${filename}`;
}

/** One demand-rendered canvas serves the native swatch buttons. */
export default function MaterialSwatches({items, selectedId, disabled = false, onSelect, layout = 'grid', renderBelow, renderActions, itemProps, shape = 'sphere', rotationControl}: MaterialSwatchesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRefs = useRef(new Map<string, HTMLSpanElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const shapeRef = useRef(shape); shapeRef.current = shape;
  const syncRef = useRef<(() => void) | null>(null);
  const orientation = useRef(new THREE.Quaternion());
  const cancelRotation = useRef<(() => void) | null>(null);
  const [states, setStates] = useState<Record<string, SwatchPreviewState>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  const hasItems = items.length > 0;
  // Data updates patch the material store; only context recovery rebuilds WebGL.
  const materialKey = JSON.stringify(items.map(({id, material}) => [id, material]));

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas || !hasItems) return;
    const sidebar = root.closest<HTMLElement>('.gesso-sidebar') ?? root;
    const control = rotationControl?.current;
    let disposed = false;
    let contextLost = false;
    let visible = false;
    let initialized = false;
    let frame = 0;
    let pointer: {x: number; y: number} | null = null;
    let controls: ReturnType<typeof bindMaterialSampleControls> | undefined;
    let previousDraw = 0;
    const lightPosition = new THREE.Vector3(-2.4, 3.2, 3.8);
    const lightTarget = new THREE.Vector3();
    let renderer: THREE.WebGLRenderer | undefined;
    let environment: THREE.WebGLRenderTarget | undefined;
    let pmrem: THREE.PMREMGenerator | undefined;
    let room: RoomEnvironment | undefined;
    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS_M, 48, 32);
    const tileGeometry = new RoundedBoxGeometry(.052, .04, .004, 3, .001);
    const cubeGeometry = new RoundedBoxGeometry(.04, .04, .04, 3, .0015);
    const baseRotation = new THREE.Quaternion();
    const baseEuler = new THREE.Euler();
    const scene = new THREE.Scene();
    const styles = getComputedStyle(root);
    const backdrop = styles.getPropertyValue('--gesso-preview-surface').trim() || styles.getPropertyValue('--chrome').trim() || '#181818';
    scene.background = new THREE.Color(backdrop);
    const camera = new THREE.PerspectiveCamera(32, 1, .001, 3);
    camera.position.set(0, 0, 4.45 * SPHERE_RADIUS_M);
    const sphere = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>(geometry, new THREE.MeshPhysicalMaterial());
    const placeholderMaterial = sphere.material;
    scene.add(sphere);
    const key = new THREE.PointLight(0xffffff, 52 * SPHERE_RADIUS_M ** 2, 0, 2);
    const fill = new THREE.HemisphereLight(0xeef1ff, 0x24201c, 0.45);
    scene.add(key, fill);

    const materials = createMaterialSwatchStore(textureUrl, () => {
      if (!disposed) {
        const next = materials.states();
        setStates(current => Object.keys(current).length === Object.keys(next).length
          && Object.keys(next).every(id => current[id] === next[id]) ? current : next);
        requestRender();
      }
    });

    function requestRender() {
      if (!disposed && !contextLost && visible && !document.hidden && !frame) frame = requestAnimationFrame(draw);
    }

    function draw(now: number) {
      frame = 0;
      const elapsed = Math.min(32, Math.max(0, now - (previousDraw || now - 16)));
      previousDraw = now;
      if (disposed || contextLost || !renderer || !visible || document.hidden) return;
      const bounds = root!.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const width = Math.ceil(bounds.width);
      const height = Math.ceil(bounds.height);
      const ratio = renderer.getPixelRatio();
      if (canvas!.width !== Math.floor(width * ratio) || canvas!.height !== Math.floor(height * ratio)) renderer.setSize(width, height, false);
      const sidebarBounds = sidebar.getBoundingClientRect();
      renderer.setScissorTest(false);
      renderer.setClearColor(backdrop, 1);
      renderer.clear();
      renderer.setScissorTest(true);
      const tile = shapeRef.current === 'rectangle', cube = shapeRef.current === 'cube';
      sphere.geometry = cube ? cubeGeometry : tile ? tileGeometry : geometry;
      baseRotation.setFromEuler(baseEuler.set(cube ? .35 : tile ? -.12 : 0, cube ? -.55 : tile ? -.22 : 0, 0));
      sphere.quaternion.copy(orientation.current).multiply(baseRotation);
      camera.position.z = (cube ? 5.2 : 4.45) * SPHERE_RADIUS_M;
      for (const item of itemsRef.current) {
        const image = imageRefs.current.get(item.id);
        const material = materials.get(item.id);
        if (!image || !material) continue;
        const rect = image.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height);
        if (!size) continue;
        const left = rect.left - bounds.left + (rect.width - size) / 2;
        const bottom = bounds.height - (rect.top - bounds.top) - (rect.height + size) / 2;
        if (pointer) {
          lightTarget.set(
            THREE.MathUtils.clamp((pointer.x - (rect.left + rect.width / 2)) / sidebarBounds.width * 8, -4, 4),
            THREE.MathUtils.clamp(((rect.top + rect.height / 2) - pointer.y) / sidebarBounds.height * 8, -4, 4),
            3.8,
          );
        } else lightTarget.set(-2.4, 3.2, 3.8);
        if (control) {
          // A released drag should not teleport the reflection to the new mouse position.
          if (!controls?.isDragging()) {
            lightPosition.lerp(lightTarget, 1 - Math.exp(-elapsed / 60));
            if (lightPosition.distanceToSquared(lightTarget) > 0.000001) requestRender();
            else lightPosition.copy(lightTarget);
          }
          key.position.copy(lightPosition);
        } else key.position.copy(lightTarget);
        key.position.multiplyScalar(SPHERE_RADIUS_M);
        sphere.material = material;
        renderer.setViewport(left, bottom, size, size);
        renderer.setScissor(left, bottom, size, size);
        renderer.render(scene, camera);
      }
      renderer.setScissorTest(false);
    }

    controls = control ? bindMaterialSampleControls(control, orientation.current, requestRender, event => {
      const bounds = sidebar.getBoundingClientRect();
      pointer = event.pointerType !== 'touch' && event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom ? {x: event.clientX, y: event.clientY} : null;
    }) : undefined;
    const abortRotation = () => controls?.cancel();
    cancelRotation.current = abortRotation;

    const contextLoss = (event: Event) => {
      event.preventDefault();
      abortRotation(); if(control)control.disabled=true;
      contextLost = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setUnavailable(true);
    };
    const contextRestore = () => {if (!disposed) setContextVersion(value => value + 1);};
    canvas.addEventListener('webglcontextlost', contextLoss);
    canvas.addEventListener('webglcontextrestored', contextRestore);
    setUnavailable(false);

    // Hidden accordions and background tabs do not need a GPU context or maps.
    // Once visible, retain the renderer until unmount so scrolling never reloads it.
    function initializeRenderer() {
      if (initialized || disposed || !visible || document.hidden) return;
      initialized = true;
      try {
        renderer = new THREE.WebGLRenderer({canvas: canvas!, antialias: true, alpha: false, powerPreference: 'low-power'});
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, control ? 2 : 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.autoClear = false;
        if(control)control.disabled=false;
        pmrem = new THREE.PMREMGenerator(renderer);
        room = new RoomEnvironment();
        environment = pmrem.fromScene(room, 0.04);
        scene.environment = environment.texture;
        scene.environmentIntensity = 0.75;
        room.dispose();
        room = undefined;
        pmrem.dispose();
        pmrem = undefined;
        syncRef.current = () => {materials.sync(itemsRef.current); requestRender();};
        syncRef.current();
      } catch {
        if(control)control.disabled=true;
        setUnavailable(true);
      }
    }

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || controls?.isDragging()) return;
      pointer = {x: event.clientX, y: event.clientY};
      requestRender();
    };
    const leave = () => {if(controls?.isDragging())return;pointer = null; requestRender();};
    const visibility = () => {
      if(document.hidden)abortRotation();
      if (document.hidden && frame) {cancelAnimationFrame(frame); frame = 0;}
      else {initializeRenderer(); requestRender();}
    };
    sidebar.addEventListener('pointermove', move, {passive: true});
    sidebar.addEventListener('pointerleave', leave);
    sidebar.addEventListener('pointercancel', leave);
    sidebar.addEventListener('scroll', requestRender, {passive: true, capture: true});
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', requestRender, {passive: true});
    window.addEventListener('resize', abortRotation, {passive: true});
    const resize = new ResizeObserver(requestRender);
    resize.observe(root);
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (!visible && frame) {cancelAnimationFrame(frame); frame = 0;}
      if (visible) {initializeRenderer(); requestRender();}
    });
    intersection.observe(root);

    return () => {
      disposed = true;
      controls?.dispose(); cancelRotation.current=null;
      syncRef.current = null;
      materials.dispose();
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      sidebar.removeEventListener('pointermove', move);
      sidebar.removeEventListener('pointerleave', leave);
      sidebar.removeEventListener('pointercancel', leave);
      sidebar.removeEventListener('scroll', requestRender, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', requestRender);
      window.removeEventListener('resize',abortRotation);
      canvas.removeEventListener('webglcontextlost', contextLoss);
      canvas.removeEventListener('webglcontextrestored', contextRestore);
      geometry.dispose();
      tileGeometry.dispose();
      cubeGeometry.dispose();
      placeholderMaterial.dispose();
      room?.dispose();
      pmrem?.dispose();
      environment?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  }, [contextVersion,rotationControl,hasItems]);

  useEffect(() => {syncRef.current?.();}, [materialKey, shape]);
  useEffect(() => {cancelRotation.current?.();}, [shape]);

  return <div className={`gesso-material-swatches${layout === 'list' ? ' is-list' : ''}`} ref={rootRef}>
    <canvas ref={canvasRef} className="gesso-material-swatch-canvas" aria-hidden="true"/>
    <div className="gesso-material-swatch-grid" role="group" aria-label="Materials">
      {items.map(item => <div key={item.id} className="gesso-material-swatch-entry" {...itemProps?.(item)}><div className="gesso-material-swatch-heading" data-actions={!!renderActions}><button type="button" className="gesso-material-swatch" aria-label={item.name}
        aria-pressed={selectedId === item.id} title={`${item.name}${item.description ? ' · ' + item.description : ''} · ${shape === 'sphere' ? '50 mm preview sphere' : shape === 'cube' ? '40 mm preview cube' : '52 × 40 mm preview tile'}`} disabled={disabled} onClick={() => onSelect(item.id)}>
        <span className="gesso-material-swatch-image" aria-hidden="true" ref={element => {
          if (element) imageRefs.current.set(item.id, element); else imageRefs.current.delete(item.id);
        }}>
          {(unavailable || states[item.id] === 'failed') ? <span className="gesso-material-swatch-fallback">No preview</span>
            : states[item.id] === 'stale' ? <span className="gesso-material-swatch-fallback">Update unavailable</span>
            : states[item.id] !== 'ready' ? <span className="gesso-material-swatch-fallback">Loading…</span> : null}
        </span>
        <span className="gesso-material-swatch-label">{layout !== 'list' && selectedId===item.id && <UiIcon name="check" size={12}/>}<span className="gesso-material-swatch-name">{item.name}</span></span>
        {item.description && <span className="gesso-material-swatch-description">{item.description}</span>}
      </button>{renderActions?.(item)}</div>{renderBelow?.(item)}</div>)}
    </div>
    {unavailable && <p className="gesso-material-preview-status" role="status">Material previews unavailable. You can still select a material.</p>}
  </div>;
}
