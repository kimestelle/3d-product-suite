import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createSurfaceMaterial, disposeSurfaceMaterial, loadMaterialTextures, type ImageAsset} from './materials';
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
}

type PreviewState = 'loading' | 'ready' | 'failed';
const SPHERE_RADIUS_M = .025;

function textureUrl(asset: ImageAsset) {
  const filename = asset.path.split('/').pop() ?? '';
  if (!/^[a-f0-9]{64}\.png$/.test(filename)) throw new Error('Invalid texture asset');
  return `/api/assets/${filename}`;
}

/** One demand-rendered canvas serves the native swatch buttons. */
export default function MaterialSwatches({items, selectedId, disabled = false, onSelect}: MaterialSwatchesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRefs = useRef(new Map<string, HTMLSpanElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [states, setStates] = useState<Record<string, PreviewState>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  // Selection and parent rerenders leave the renderer and loaded images intact.
  const materialKey = JSON.stringify(items.map(({id, material}) => [id, material]));

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const sidebar = root.closest<HTMLElement>('.gesso-sidebar') ?? root;
    const controller = new AbortController();
    const currentItems = itemsRef.current;
    const previewStates: Record<string, PreviewState> = {};
    let disposed = false;
    let contextLost = false;
    let visible = true;
    let frame = 0;
    let pointer: {x: number; y: number} | null = null;
    let renderer: THREE.WebGLRenderer | undefined;
    let environment: THREE.WebGLRenderTarget | undefined;
    let pmrem: THREE.PMREMGenerator | undefined;
    let room: RoomEnvironment | undefined;
    const materials = new Map<string, THREE.MeshPhysicalMaterial>();
    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS_M, 48, 32);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#131313');
    const camera = new THREE.PerspectiveCamera(32, 1, .001, 3);
    camera.position.set(0, 0, 4.45 * SPHERE_RADIUS_M);
    const sphere = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial());
    const placeholderMaterial = sphere.material;
    scene.add(sphere);
    const key = new THREE.PointLight(0xffffff, 52 * SPHERE_RADIUS_M ** 2, 0, 2);
    const fill = new THREE.HemisphereLight(0xeef1ff, 0x24201c, 0.45);
    scene.add(key, fill);

    function publishStates() {
      if (!disposed) setStates({...previewStates});
    }

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
      for (const item of currentItems) {
        const image = imageRefs.current.get(item.id);
        const material = materials.get(item.id);
        if (!image || !material || previewStates[item.id] !== 'ready') continue;
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
      for (const item of currentItems) {
        const material = createSurfaceMaterial(item.material);
        materials.set(item.id, material);
        if (Object.values(item.material.textures ?? {}).some(Boolean)) {
          previewStates[item.id] = 'loading';
          void loadMaterialTextures(material, item.material, textureUrl, {signal: controller.signal}).then(() => {
            if (disposed) return;
            previewStates[item.id] = 'ready';
            publishStates();
            requestRender();
          }).catch(() => {
            if (disposed || controller.signal.aborted) return;
            previewStates[item.id] = 'failed';
            publishStates();
            requestRender();
          });
        } else previewStates[item.id] = 'ready';
      }
      publishStates();
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
      controller.abort();
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
      placeholderMaterial.dispose();
      for (const material of materials.values()) disposeSurfaceMaterial(material);
      room?.dispose();
      pmrem?.dispose();
      environment?.dispose();
      renderer?.dispose();
    };
  }, [materialKey, contextVersion]);

  return <div className="gesso-material-swatches" ref={rootRef}>
    <canvas ref={canvasRef} className="gesso-material-swatch-canvas" aria-hidden="true"/>
    <div className="gesso-material-swatch-grid" role="group" aria-label="Materials">
      {items.map(item => <button key={item.id} type="button" className="gesso-material-swatch" aria-label={item.name}
        aria-pressed={selectedId === item.id} title={`${item.name}${item.description ? ' · ' + item.description : ''} · 50 mm preview sphere`} disabled={disabled} onClick={() => onSelect(item.id)}>
        <span className="gesso-material-swatch-image" aria-hidden="true" ref={element => {
          if (element) imageRefs.current.set(item.id, element); else imageRefs.current.delete(item.id);
        }}>
          {(unavailable || states[item.id] === 'failed') ? <span className="gesso-material-swatch-fallback">No preview</span>
            : states[item.id] !== 'ready' ? <span className="gesso-material-swatch-fallback">Loading…</span> : null}
        </span>
        <span className="gesso-material-swatch-label">{selectedId===item.id && <UiIcon name="check" size={12}/>}<span className="gesso-material-swatch-name">{item.name}</span></span>
        {item.description && <span className="gesso-material-swatch-description">{item.description}</span>}
      </button>)}
    </div>
    {unavailable && <p className="gesso-material-preview-status" role="status">Material previews unavailable. You can still select a material.</p>}
  </div>;
}
