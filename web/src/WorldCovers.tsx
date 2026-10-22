import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {disposeSceneObject} from './sceneObjects';
import {captureWorldCoverWithRetry, createWorldCoverObject, fitWorldCover, worldCoverForItem, worldCoverKey, type WorldCover, type WorldCoverItem} from './worldCover';
import './world-covers.css';

export interface CurrentWorldCapture {
  captureCurrentWorld?: (signal: AbortSignal) => Promise<Blob>;
  worldPreviewReady?: boolean;
  worldPreviewRevision?: string;
}

// Static, small PNGs survive tab switches. No scene/GPU resources are cached.
const cache = new Map<string, WorldCover>();
const viewportKeys = new Set<string>();
function store(key: string, cover: WorldCover, viewport = false) {
  if (!viewport && viewportKeys.has(key)) return;
  if (viewport) viewportKeys.add(key);
  cache.delete(key); cache.set(key, cover);
  while (cache.size > 48) {const oldest = cache.keys().next().value!; cache.delete(oldest); viewportKeys.delete(oldest);}
}
function pngUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Preview unavailable.'));
    reader.readAsDataURL(blob);
  });
}

/** A single demand renderer services visible authored geometry. Mesh/splat
 * cards only use small images or a capture from the already-loaded scene. */
export function useWorldCovers(items: WorldCoverItem[], current: WorldCoverItem, options: CurrentWorldCapture) {
  const entries = useRef(new Map<string, HTMLElement>());
  const itemsRef = useRef(items); itemsRef.current = items;
  const currentRef = useRef(current); currentRef.current = current;
  const syncRef = useRef<(() => void) | null>(null);
  const syncQueued = useRef(false);
  const [covers, setCovers] = useState<Record<string, WorldCover>>(() => Object.fromEntries(cache));
  const key = JSON.stringify(items.map(item => [item.id, worldCoverKey(item.environment, item.productDimensionsM), item.previewAsset]));
  const selectedKey = worldCoverKey(current.environment, current.productDimensionsM);
  const publish = () => setCovers(Object.fromEntries(cache));

  useEffect(() => {
    let disposed = false, busy = false, unavailable = false;
    let active: AbortController | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const attempted = new Set<string>();
    const visible = new Set<string>();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, .001, 100);
    scene.add(new THREE.HemisphereLight(0xf3f1e8, 0x454a43, 1.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2); keyLight.position.set(-2, 3, 4); scene.add(keyLight);
    const releaseRenderer = () => {renderer?.dispose(); renderer?.forceContextLoss(); renderer = undefined;};
    const publishSafe = () => {if (!disposed) publish();};
    const next = async () => {
      if (disposed || busy || unavailable || document.hidden) return;
      const candidate = [currentRef.current, ...itemsRef.current].find(item => {
        const candidateKey = worldCoverKey(item.environment, item.productDimensionsM);
        const cover = worldCoverForItem(item, cache.get(candidateKey));
        return item.environment.kind === 'authored' && (item.id === currentRef.current.id || visible.has(item.id))
          && cover.state === 'loading' && !attempted.has(candidateKey);
      });
      if (!candidate) {clearTimeout(idle); idle = setTimeout(releaseRenderer, 400); return;}
      clearTimeout(idle);
      const candidateKey = worldCoverKey(candidate.environment, candidate.productDimensionsM);
      attempted.add(candidateKey); busy = true; active = new AbortController();
      store(candidateKey, {state: 'loading'}); publishSafe();
      let object: THREE.Object3D | undefined;
      try {
        object = await createWorldCoverObject(candidate.environment, active.signal, candidate.productDimensionsM) ?? undefined;
        if (disposed || active.signal.aborted) return;
        if (!object) {store(candidateKey, {state: 'open'}); return;}
        if (!renderer) {
          try {
            renderer = new THREE.WebGLRenderer({antialias: true, alpha: false, powerPreference: 'low-power'});
            renderer.setPixelRatio(1); renderer.setSize(320, 180, false);
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
          } catch (error) {unavailable = true; throw error;}
        }
        scene.background = new THREE.Color().fromArray(candidate.environment.worldColor ?? [.08, .08, .08]);
        scene.add(object); fitWorldCover(camera, object); renderer.render(scene, camera);
        const blob = await new Promise<Blob>((resolve, reject) => renderer!.domElement.toBlob(value => value ? resolve(value) : reject(new Error('Preview unavailable.')), 'image/png'));
        const url = await pngUrl(blob);
        if (!disposed && !active.signal.aborted) store(candidateKey, {state: 'ready', url});
      } catch {
        if (!disposed && !active.signal.aborted) store(candidateKey, {state: 'failed'});
      } finally {
        if (object) {object.removeFromParent(); disposeSceneObject(object);}
        if (disposed && cache.get(candidateKey)?.state === 'loading') cache.delete(candidateKey);
        busy = false; active = undefined; publishSafe();
        if (!disposed) void next();
      }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(records => {
      for (const record of records) {
        const id = (record.target as HTMLElement).dataset.worldId!;
        if (record.isIntersecting) visible.add(id); else visible.delete(id);
      }
      void next();
    }, {rootMargin: '80px'});
    const sync = () => {
      observer?.disconnect(); visible.clear();
      for (const [id, element] of entries.current) {if (observer) observer.observe(element); else visible.add(id);}
      void next();
    };
    const visibility = () => {if (!document.hidden) void next();};
    syncRef.current = sync;
    document.addEventListener('visibilitychange', visibility); sync();
    return () => {
      disposed = true; active?.abort(); clearTimeout(idle); observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility); syncRef.current = null; releaseRenderer();
    };
  }, []);
  useEffect(() => {syncRef.current?.();}, [key, selectedKey]);

  useEffect(() => {
    if (!options.captureCurrentWorld || !options.worldPreviewReady) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void captureWorldCoverWithRetry(options.captureCurrentWorld!, controller.signal).then(pngUrl).then(url => {
        if (controller.signal.aborted) return;
        store(selectedKey, {state: 'ready', url}, true); publish();
      }).catch(() => {
        if (!controller.signal.aborted && !cache.get(selectedKey)?.url) {store(selectedKey, {state: 'failed'}); publish();}
      });
    }, 160);
    return () => {clearTimeout(timer); controller.abort();};
  }, [selectedKey, options.captureCurrentWorld, options.worldPreviewReady, options.worldPreviewRevision]);

  const displayedCovers = Object.fromEntries([...items, current].map(item => {
    const itemKey = worldCoverKey(item.environment, item.productDimensionsM);
    return [itemKey, worldCoverForItem(item, covers[itemKey])];
  }));
  return {covers: displayedCovers, observe: (id: string, element: HTMLElement | null) => {
    if (element) entries.current.set(id, element); else entries.current.delete(id);
    if (!syncQueued.current) {
      syncQueued.current = true;
      queueMicrotask(() => {syncQueued.current = false; syncRef.current?.();});
    }
  }};
}

export function WorldCoverImage({name, cover, selected = false}: {name: string; cover?: WorldCover; selected?: boolean}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = cover?.url !== failedUrl ? cover?.url : undefined;
  return <span className="gesso-world-cover-image">
    {url ? <img src={url} alt={`${name} preview`} width="320" height="180" loading="lazy" decoding="async" onError={() => setFailedUrl(url)}/> : <span className="gesso-world-cover-empty">{cover?.state === 'failed' ? 'Preview unavailable' : cover?.state === 'open' || !!failedUrl ? selected ? 'Waiting for scene' : 'Open to preview' : 'Loading preview…'}</span>}
  </span>;
}
