import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createWorldObjectPreview, fitWorldObjectPreview, worldObjectPreviewKey, type WorldObjectPreviewItem} from './worldObjectPreview';
import {disposeSceneObject} from './sceneObjects';
import './world-object-previews.css';

export type {WorldObjectPreviewItem} from './worldObjectPreview';
export interface WorldObjectPreviewsProps {
  items: WorldObjectPreviewItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
}
type Preview = {key: string; state: 'loading' | 'ready' | 'failed'; url?: string};

/** One small renderer produces static, inspectable thumbnails only when needed.
 * Only visible entries load; each object's GPU resources are released after capture. */
export default function WorldObjectPreviews({items, selectedId, onSelect}: WorldObjectPreviewsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<string, HTMLButtonElement>());
  const itemsRef = useRef(items); itemsRef.current = items;
  const syncRef = useRef<(() => void) | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [unavailable, setUnavailable] = useState(false);
  const key = JSON.stringify(items.map(item => [item.id, worldObjectPreviewKey(item)]));

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visible = new Set<string>();
    const cache = new Map<string, Preview>();
    const canvas = document.createElement('canvas');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 2, .001, 100);
    const styles = getComputedStyle(root);
    scene.background = new THREE.Color(styles.getPropertyValue('--gesso-preview-surface').trim() || styles.getPropertyValue('--chrome').trim() || '#181818');
    const fill = new THREE.HemisphereLight(0xeef1ff, 0x24201c, 1.05);
    const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(-2, 3, 4);
    scene.add(fill, light);
    let renderer: THREE.WebGLRenderer | undefined;
    let environment: THREE.WebGLRenderTarget | undefined;
    let disposed = false;
    let busy = false;
    let contextLost = false;
    let current: {id: string; key: string; abort: AbortController} | undefined;
    let scheduled = 0;

    const publish = () => {if (!disposed) setPreviews(Object.fromEntries(cache));};
    const release = (preview?: Preview) => {if (preview?.url) URL.revokeObjectURL(preview.url);};
    function initializeRenderer() {
      if (renderer) return;
      renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false, powerPreference: 'low-power'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(280, 140, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      try {environment = pmrem.fromScene(room, .04); scene.environment = environment.texture; scene.environmentIntensity = .75;}
      finally {room.dispose(); pmrem.dispose();}
    }
    function requestNext() {
      if (!disposed && !busy && !contextLost && !document.hidden && !scheduled) scheduled = requestAnimationFrame(() => {scheduled = 0; void renderNext();});
    }
    async function renderNext() {
      if (disposed || busy || contextLost || document.hidden) return;
      const item = itemsRef.current.find(candidate => visible.has(candidate.id) && cache.get(candidate.id)?.key !== worldObjectPreviewKey(candidate));
      if (!item) return;
      const renderKey = worldObjectPreviewKey(item);
      const abort = new AbortController();
      current = {id: item.id, key: renderKey, abort};
      busy = true;
      // Preserve a complete previous image until its replacement is ready.
      const previous = cache.get(item.id);
      cache.set(item.id, {key: renderKey, state: 'loading', url: previous?.url}); publish();
      let object: THREE.Object3D | undefined;
      try {
        initializeRenderer();
        object = await createWorldObjectPreview(item, abort.signal);
        if (disposed || contextLost || abort.signal.aborted) return;
        scene.add(object);
        fitWorldObjectPreview(camera, object, 2);
        renderer!.render(scene, camera);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Preview capture unavailable.')), 'image/webp', .9));
        if (disposed || abort.signal.aborted) return;
        const latest = itemsRef.current.find(candidate => candidate.id === item.id);
        if (!latest || worldObjectPreviewKey(latest) !== renderKey) return;
        const url = URL.createObjectURL(blob);
        release(previous);
        cache.set(item.id, {key: renderKey, state: 'ready', url}); publish();
      } catch (error) {
        if (!disposed && !abort.signal.aborted) {
          cache.set(item.id, {key: renderKey, state: 'failed', url: previous?.url}); publish();
          if (!renderer) {setUnavailable(true); contextLost = true;}
        }
      } finally {
        if (object) {object.removeFromParent(); disposeSceneObject(object);}
        if (abort.signal.aborted && cache.get(item.id)?.key === renderKey) {
          const pending = cache.get(item.id)!;
          cache.set(item.id, {...pending, key: ''});
        }
        current = undefined; busy = false;
        requestNext();
      }
    }
    const observer = new IntersectionObserver(records => {
      for (const record of records) {
        const id = (record.target as HTMLElement).dataset.previewId!;
        if (record.isIntersecting) visible.add(id); else visible.delete(id);
      }
      requestNext();
    }, {root: root.closest('.gesso-sidebar-content'), rootMargin: '140px'});
    const sync = () => {
      const ids = new Set(itemsRef.current.map(item => item.id));
      for (const [id, preview] of cache) if (!ids.has(id)) {release(preview); cache.delete(id); visible.delete(id);}
      if (current) {
        const next = itemsRef.current.find(item => item.id === current!.id);
        if (!next || worldObjectPreviewKey(next) !== current.key) current.abort.abort();
      }
      observer.disconnect();
      for (const element of entries.current.values()) observer.observe(element);
      publish(); requestNext();
    };
    const visibility = () => {if (document.hidden && scheduled) {cancelAnimationFrame(scheduled); scheduled = 0;} else requestNext();};
    const lost = (event: Event) => {event.preventDefault(); contextLost = true; current?.abort.abort(); setUnavailable(true);};
    const restored = () => {
      contextLost = false; setUnavailable(false);
      environment?.dispose(); environment = undefined; renderer?.dispose(); renderer = undefined;
      // Existing static images survive; only missing previews need rendering.
      for (const [id, preview] of cache) if (!preview.url) cache.delete(id);
      requestNext();
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    document.addEventListener('visibilitychange', visibility);
    syncRef.current = sync; sync();
    return () => {
      disposed = true; syncRef.current = null; current?.abort.abort();
      if (scheduled) cancelAnimationFrame(scheduled);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      cache.forEach(release); cache.clear();
      environment?.dispose(); renderer?.dispose();
    };
  }, []);
  useEffect(() => {syncRef.current?.();}, [key]);

  return <div className="gesso-world-object-previews gesso-selection-surface" ref={rootRef} role="group" aria-label="World objects">
    {items.map(item => {
      const preview = previews[item.id];
      return <button type="button" className="gesso-world-object-preview" key={item.id} data-preview-id={item.id} data-object-id={item.id} aria-controls="world-object-settings"
        aria-label={`Edit ${item.name}`} aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}
        ref={element => {if (element) entries.current.set(item.id, element); else entries.current.delete(item.id);}}>
        <span className="gesso-world-object-preview-image" aria-hidden="true">
          {preview?.url && <img src={preview.url} alt="" width={280} height={140}/>}
          {preview?.state !== 'ready' && <span className="gesso-world-object-preview-status">
            {unavailable || preview?.state === 'failed' ? (preview?.url ? 'Update unavailable' : 'Preview unavailable') : 'Loading…'}
          </span>}
        </span>
        <span className="gesso-world-object-preview-name">{item.name}</span>
        {item.description && <span className="gesso-world-object-preview-description">{item.description}</span>}
      </button>;
    })}
  </div>;
}
