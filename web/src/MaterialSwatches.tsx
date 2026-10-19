import {useEffect, useRef, useState, type HTMLAttributes, type ReactNode} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {type ImageAsset} from './materials';
import {createMaterialSwatchStore, type SwatchPreviewState} from './materialSwatchStore';
import {UiIcon} from './UiIcon';
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
  itemProps?: (item: MaterialSwatchItem) => HTMLAttributes<HTMLDivElement>;
  shape?: 'sphere' | 'rectangle';
}

const SPHERE_RADIUS_M = .025;

function textureUrl(asset: ImageAsset) {
  const filename = asset.path.split('/').pop() ?? '';
  if (!/^[a-f0-9]{64}\.png$/.test(filename)) throw new Error('Invalid texture asset');
  return `/api/assets/${filename}`;
}

/** One demand-rendered canvas serves the native swatch buttons. */
export default function MaterialSwatches({items, selectedId, disabled = false, onSelect, layout = 'grid', renderBelow, itemProps, shape = 'sphere'}: MaterialSwatchesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRefs = useRef(new Map<string, HTMLSpanElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const shapeRef = useRef(shape); shapeRef.current = shape;
  const syncRef = useRef<(() => void) | null>(null);
  const [states, setStates] = useState<Record<string, SwatchPreviewState>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  // Data updates patch the material store; only context recovery rebuilds WebGL.
  const materialKey = JSON.stringify(items.map(({id, material}) => [id, material]));

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const sidebar = root.closest<HTMLElement>('.gesso-sidebar') ?? root;
    let disposed = false;
    let contextLost = false;
    let visible = true;
    let frame = 0;
    let pointer: {x: number; y: number} | null = null;
    let renderer: THREE.WebGLRenderer | undefined;
    let environment: THREE.WebGLRenderTarget | undefined;
    let pmrem: THREE.PMREMGenerator | undefined;
    let room: RoomEnvironment | undefined;
    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS_M, 48, 32);
    const tileGeometry = new RoundedBoxGeometry(.052, .04, .004, 3, .001);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#131313');
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

    function draw() {
      frame = 0;
      if (disposed || contextLost || !renderer || !visible || document.hidden) return;
      const bounds = root!.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const width = Math.ceil(bounds.width);
      const height = Math.ceil(bounds.height);
      const ratio = renderer.getPixelRatio();
      if (canvas!.width !== Math.floor(width * ratio) || canvas!.height !== Math.floor(height * ratio)) renderer.setSize(width, height, false);
      const sidebarBounds = sidebar.getBoundingClientRect();
      renderer.setScissorTest(false);
      renderer.setClearColor('#131313', 1);
      renderer.clear();
      renderer.setScissorTest(true);
      const tile = shapeRef.current === 'rectangle';
      sphere.geometry = tile ? tileGeometry : geometry;
      sphere.rotation.set(tile ? -.12 : 0, tile ? -.22 : 0, 0);
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
          key.position.set(
            THREE.MathUtils.clamp((pointer.x - (rect.left + rect.width / 2)) / sidebarBounds.width * 8, -4, 4),
            THREE.MathUtils.clamp(((rect.top + rect.height / 2) - pointer.y) / sidebarBounds.height * 8, -4, 4),
            3.8,
          );
        } else key.position.set(-2.4, 3.2, 3.8);
        key.position.multiplyScalar(SPHERE_RADIUS_M);
        sphere.material = material;
        renderer.setViewport(left, bottom, size, size);
        renderer.setScissor(left, bottom, size, size);
        renderer.render(scene, camera);
      }
      renderer.setScissorTest(false);
    }

    const contextLoss = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setUnavailable(true);
    };
    const contextRestore = () => {if (!disposed) setContextVersion(value => value + 1);};
    canvas.addEventListener('webglcontextlost', contextLoss);
    canvas.addEventListener('webglcontextrestored', contextRestore);
    setUnavailable(false);

    try {
      renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false, powerPreference: 'low-power'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.autoClear = false;
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
      requestRender();
    } catch {
      setUnavailable(true);
    }

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer = {x: event.clientX, y: event.clientY};
      requestRender();
    };
    const leave = () => {pointer = null; requestRender();};
    const visibility = () => {
      if (document.hidden && frame) {cancelAnimationFrame(frame); frame = 0;}
      else requestRender();
    };
    sidebar.addEventListener('pointermove', move, {passive: true});
    sidebar.addEventListener('pointerleave', leave);
    sidebar.addEventListener('pointercancel', leave);
    sidebar.addEventListener('scroll', requestRender, {passive: true, capture: true});
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', requestRender, {passive: true});
    const resize = new ResizeObserver(requestRender);
    resize.observe(root);
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (!visible && frame) {cancelAnimationFrame(frame); frame = 0;}
      if (visible) requestRender();
    });
    intersection.observe(root);

    return () => {
      disposed = true;
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
      canvas.removeEventListener('webglcontextlost', contextLoss);
      canvas.removeEventListener('webglcontextrestored', contextRestore);
      geometry.dispose();
      tileGeometry.dispose();
      placeholderMaterial.dispose();
      room?.dispose();
      pmrem?.dispose();
      environment?.dispose();
      renderer?.dispose();
    };
  }, [contextVersion]);

  useEffect(() => {syncRef.current?.();}, [materialKey, shape]);

  return <div className={`gesso-material-swatches${layout === 'list' ? ' is-list' : ''}`} ref={rootRef}>
    <canvas ref={canvasRef} className="gesso-material-swatch-canvas" aria-hidden="true"/>
    <div className="gesso-material-swatch-grid" role="group" aria-label="Materials">
      {items.map(item => <div key={item.id} className="gesso-material-swatch-entry" {...itemProps?.(item)}><button type="button" className="gesso-material-swatch" aria-label={item.name}
        aria-pressed={selectedId === item.id} title={`${item.name}${item.description ? ' · ' + item.description : ''} · ${shape === 'sphere' ? '50 mm preview sphere' : '52 × 40 mm preview tile'}`} disabled={disabled} onClick={() => onSelect(item.id)}>
        <span className="gesso-material-swatch-image" aria-hidden="true" ref={element => {
          if (element) imageRefs.current.set(item.id, element); else imageRefs.current.delete(item.id);
        }}>
          {(unavailable || states[item.id] === 'failed') ? <span className="gesso-material-swatch-fallback">No preview</span>
            : states[item.id] === 'stale' ? <span className="gesso-material-swatch-fallback">Update unavailable</span>
            : states[item.id] !== 'ready' ? <span className="gesso-material-swatch-fallback">Loading…</span> : null}
        </span>
        <span className="gesso-material-swatch-label">{layout !== 'list' && selectedId===item.id && <UiIcon name="check" size={12}/>}<span className="gesso-material-swatch-name">{item.name}</span></span>
        {item.description && <span className="gesso-material-swatch-description">{item.description}</span>}
      </button>{renderBelow?.(item)}</div>)}
    </div>
    {unavailable && <p className="gesso-material-preview-status" role="status">Material previews unavailable. You can still select a material.</p>}
  </div>;
}
