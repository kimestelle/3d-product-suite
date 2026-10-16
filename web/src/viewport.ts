import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

type ViewportOptions = {
  capture?: boolean;
  onSelect?: (id: string) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
};

/** The browser only consumes poses sampled by film.scene; it evaluates no motion. */
export class StudioViewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 9 / 16, 0.001, 100);
  private readonly content = new THREE.Group();
  private readonly components = new Map<string, THREE.Group>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver?: IntersectionObserver;
  private readonly options: ViewportOptions;
  private readonly canvas: HTMLCanvasElement;
  private selection: THREE.BoxHelper | null = null;
  private selectedId: string | null = null;
  private spark: SparkRenderer | null = null;
  private splat: SplatMesh | null = null;
  private disposed = false;
  private visible = true;
  private dirty = false;
  private pendingRender = 0;
  private loadVersion = 0;
  private loading = false;
  private frameQueue: Promise<void> = Promise.resolve();
  private renderQueue: Promise<void> = Promise.resolve();
  private frameRequest = 0;

  constructor(canvas: HTMLCanvasElement, options: ViewportOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !options.capture, preserveDrawingBuffer: !!options.capture });
    this.renderer.setPixelRatio(options.capture ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Plates enter Blender as sRGB, are composited in linear light, then receive
    // Blender's AgX view transform once. Never bake a filmic curve into plates.
    this.renderer.toneMapping = options.capture ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = !options.capture;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(0.17, 0.15, 0.35);
    this.camera.lookAt(0, 0.073, 0);
    this.scene.add(this.content);
    this.resizeObserver = new ResizeObserver(() => { this.resize(); this.invalidate(); });
    this.resizeObserver.observe(canvas);
    if (!options.capture && typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(entries => {
        this.visible = entries[0]?.isIntersecting ?? true;
        if (this.visible) this.invalidate();
        else this.cancelRender();
      });
      this.intersectionObserver.observe(canvas);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.resize();
  }

  private onVisibility = () => {
    if (document.hidden) this.cancelRender();
    else if (this.dirty) this.invalidate();
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.options.onError?.('The 3D graphics context was lost. Reopen this project to restore the preview.');
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.options.capture || this.disposed || event.button !== 0) return;
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.components.values()], true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && !node.userData.componentId) node = node.parent;
      if (node?.userData.componentId) {
        this.options.onSelect?.(node.userData.componentId);
        return;
      }
    }
  };

  resize(): void {
    if (this.disposed) return;
    // Capture callers establish integer canvas.width/height before constructing
    // us. Do not multiply those by DPR or by the CSS dimensions.
    const width = this.options.capture ? this.canvas.width : Math.round(this.canvas.clientWidth || this.canvas.width);
    const height = this.options.capture ? this.canvas.height : Math.round(this.canvas.clientHeight || this.canvas.height);
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private cancelRender(): void {
    if (this.pendingRender) cancelAnimationFrame(this.pendingRender);
    this.pendingRender = 0;
  }

  private invalidate(): void {
    this.dirty = true;
    if (this.disposed || this.loading || this.options.capture || this.pendingRender || document.hidden || !this.visible) return;
    this.pendingRender = requestAnimationFrame(() => {
      this.pendingRender = 0;
      void this.render(false).catch(error => {
        if (!this.disposed) this.options.onError?.(String(error?.message || error));
      });
    });
  }

  private color(values: number[]): THREE.Color {
    // Scene baseColor values are linear, matching Blender's shader inputs.
    return new THREE.Color().setRGB(values[0], values[1], values[2], THREE.LinearSRGBColorSpace);
  }

  private surface(specification: any): THREE.MeshPhysicalMaterial {
    const rgba = specification.baseColor;
    const transmission = specification.transmission ?? 0;
    return new THREE.MeshPhysicalMaterial({
      color: this.color(rgba), roughness: specification.roughness,
      metalness: specification.metallic, opacity: rgba[3], transparent: rgba[3] < 1,
      transmission, ior: specification.ior ?? 1.5,
      thickness: transmission ? 0.006 : 0,
    });
  }

  private geometry(shape: string, size: number[], bevel = 0): THREE.BufferGeometry {
    const radius = Math.min(bevel, Math.min(...size) * 0.45);
    if (shape === 'box') return radius > 0
      ? new RoundedBoxGeometry(size[0], size[1], size[2], 5, radius)
      : new THREE.BoxGeometry(size[0], size[1], size[2]);
    if (shape !== 'cylinder') throw new Error(`Unsupported component shape: ${shape}`);
    // Lathe is Y-up. Keep the exact declared dimensions, including elliptical
    // cylinders, and apply bevel to geometry rather than changing the pose.
    const halfHeight = size[1] / 2;
    const r = size[0] / 2;
    const b = Math.min(radius, r * 0.9);
    const profile = [new THREE.Vector2(0, -halfHeight), new THREE.Vector2(r - b, -halfHeight)];
    for (let step = 0; step <= 5; step++) {
      const angle = step * Math.PI / 10;
      profile.push(new THREE.Vector2(r - b + b * Math.sin(angle), -halfHeight + b - b * Math.cos(angle)));
    }
    profile.push(new THREE.Vector2(r, halfHeight - b));
    for (let step = 0; step <= 5; step++) {
      const angle = step * Math.PI / 10;
      profile.push(new THREE.Vector2(r - b + b * Math.cos(angle), halfHeight - b + b * Math.sin(angle)));
    }
    profile.push(new THREE.Vector2(0, halfHeight));
    const geometry = new THREE.LatheGeometry(profile, 128);
    geometry.scale(1, 1, size[2] / size[0]);
    return geometry;
  }

  private makeProduct(source: any): void {
    for (const specification of source.product.components) {
      const group = new THREE.Group();
      group.name = specification.id;
      group.userData.componentId = specification.id;
      const mesh = new THREE.Mesh(this.geometry(specification.shape, specification.sizeM, specification.bevelM), this.surface(specification.material));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      group.position.fromArray(specification.assembly.translationM);
      group.position.add(new THREE.Vector3().fromArray(source.placement.translationM));
      group.quaternion.fromArray(specification.assembly.rotationXyzw);
      this.components.set(specification.id, group);
      this.content.add(group);
    }
    const label = source.product.label;
    if (label && this.components.has(label.componentId)) {
      const component = source.product.components.find((item: any) => item.id === label.componentId);
      this.addLabel(this.components.get(label.componentId)!, label, component.sizeM);
    }
  }

  private addLabel(parent: THREE.Group, specification: any, size: number[]): void {
    const artwork = document.createElement('canvas');
    artwork.width = 1024;
    artwork.height = Math.max(256, Math.round(1024 * size[1] / size[0]));
    const context = artwork.getContext('2d');
    if (!context) throw new Error('Canvas text rendering is unavailable.');
    context.clearRect(0, 0, artwork.width, artwork.height);
    context.fillStyle = '#344036';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const draw = (text: string, vertical: number, maxWidth: number, height: number) => {
      if (!text) return;
      let fontSize = height * artwork.height;
      context.font = `500 ${fontSize}px "Studio Sans", Arial, sans-serif`;
      const measured = context.measureText(text).width;
      if (measured > artwork.width * maxWidth) {
        fontSize *= artwork.width * maxWidth / measured;
        context.font = `500 ${fontSize}px "Studio Sans", Arial, sans-serif`;
      }
      context.fillText(text, artwork.width / 2, artwork.height * (0.5 - vertical));
    };
    draw(specification.text || '', 0.13, 0.84, 0.24);
    draw(specification.subtitle || '', -0.23, 0.85, 0.065);
    const texture = new THREE.CanvasTexture(artwork);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const ink = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), ink);
    plane.name = 'Declared label artwork';
    plane.position.z = size[2] / 2 + 0.00012;
    parent.add(plane);
  }

  private makeStudio(source: any): void {
    const plinth = source.environment.plinth;
    const material = new THREE.MeshStandardMaterial({ color: this.color([0.56, 0.54, 0.49]), roughness: 0.58 });
    const ledge = new THREE.Mesh(this.geometry('box', plinth.sizeM, 0.004), material);
    ledge.name = 'Explicit contact plinth';
    ledge.position.fromArray(plinth.translationM);
    ledge.castShadow = true;
    ledge.receiveShadow = true;
    this.content.add(ledge);
    for (const specification of source.environment.props || []) {
      const prop = new THREE.Mesh(this.geometry(specification.shape, specification.sizeM, specification.bevelM), this.surface(specification.material));
      prop.name = specification.id;
      prop.position.fromArray(specification.translationM);
      prop.quaternion.fromArray(specification.rotationXyzw);
      prop.castShadow = true;
      prop.receiveShadow = true;
      this.content.add(prop);
    }
    if (source.environment.kind === 'authored') {
      const floorHeight = plinth.translationM[1] - plinth.sizeM[1] / 2 - 0.0001;
      const radius = Math.max(...source.product.dimensionsM) * 3;
      const profile = [[radius * 15, floorHeight], [-radius, floorHeight]];
      for (let step = 1; step <= 32; step++) {
        const angle = step * Math.PI / 64;
        profile.push([-radius - radius * Math.sin(angle), floorHeight + radius * (1 - Math.cos(angle))]);
      }
      profile.push([-radius * 2, floorHeight + radius * 15]);
      const positions: number[] = [];
      const indices: number[] = [];
      profile.forEach(([z, y], index) => {
        positions.push(-radius * 15, y, z, radius * 15, y, z);
        if (index) {
          const n = index * 2;
          indices.push(n - 2, n - 1, n + 1, n - 2, n + 1, n);
        }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const floor = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: this.color([0.26, 0.28, 0.26]), roughness: 0.72, side: THREE.DoubleSide }));
      floor.receiveShadow = true;
      this.content.add(floor);
    }
    const ambient = new THREE.HemisphereLight(0xf3f1e8, 0x454a43, 1.2);
    this.content.add(ambient);
    const size = Math.max(...source.product.dimensionsM);
    const scale = size / 0.12;
    const placement = new THREE.Vector3().fromArray(source.placement.translationM);
    const target = placement.clone().add(new THREE.Vector3(0, size * 0.52, 0));
    const configurations: [number[], number, number, number][] = [
      [[-0.19, 0.32, 0.24], 0xffedcf, 2.4, 0.23],
      [[0.22, 0.19, 0.07], 0xd1e8ff, 0.9, 0.20],
      [[0.06, 0.30, -0.19], 0xfffae6, 3, 0.16],
    ];
    for (const [offset, color, intensity, diameter] of configurations) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.fromArray(offset).multiplyScalar(scale).add(placement);
      light.target.position.copy(target);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.left = -size * 2;
      light.shadow.camera.right = size * 2;
      light.shadow.camera.top = size * 3;
      light.shadow.camera.bottom = -size;
      light.shadow.camera.near = 0.001;
      light.shadow.camera.far = size * 15;
      light.shadow.bias = -0.00005;
      light.shadow.normalBias = 0.0001;
      light.shadow.radius = diameter * 20;
      this.content.add(light, light.target);
    }
  }

  private alignWorld(root: THREE.Object3D, asset: any): void {
    const sourceUp = new THREE.Quaternion();
    if (asset.sourceUp === 'Z') sourceUp.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const rotation = new THREE.Quaternion().fromArray(asset.rotationXyzw || [0, 0, 0, 1]);
    root.quaternion.copy(rotation).multiply(sourceUp);
    root.scale.setScalar(asset.scaleToMeters ?? 1);
    root.position.fromArray(asset.translationM || [0, 0, 0]);
  }

  async load(source: any, assetUrl?: string): Promise<void> {
    if (this.disposed) throw new Error('Viewport has been disposed.');
    const version = ++this.loadVersion;
    this.frameRequest++;
    this.loading = true;
    this.cancelRender();
    this.clearContent();
    const environment = source.environment;
    const capture = !!this.options.capture;
    this.scene.background = capture ? null : this.color(environment.worldColor);
    try {
      if (capture && environment.kind !== 'splat') throw new Error('Capture requires a Gaussian splat world.');
      if (!capture) {
        // The packaged font keeps label artwork independent of host fontconfig
        // and must finish loading before measuring/drawing its canvas texture.
        await document.fonts.load('500 32px "Studio Sans"');
        if (version !== this.loadVersion || this.disposed) return;
        this.makeProduct(source);
        this.makeStudio(source);
      }
      if (environment.kind === 'mesh') {
        const url = assetUrl || this.assetUrl(environment.asset);
        const gltf = await new GLTFLoader().loadAsync(url);
        if (version !== this.loadVersion || this.disposed) { this.disposeObject(gltf.scene); return; }
        const root = new THREE.Group();
        this.alignWorld(root, environment.asset);
        root.add(gltf.scene);
        const excluded: THREE.Object3D[] = [];
        gltf.scene.traverse(object => {
          if (object instanceof THREE.Camera || object instanceof THREE.Light) excluded.push(object);
          if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
        });
        excluded.forEach(object => object.removeFromParent());
        this.content.add(root);
      } else if (environment.kind === 'splat') {
        const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
        if (version !== this.loadVersion || this.disposed) return;
        // Explicit updates await driveSort() all the way through worker sorting
        // in Spark 2.3.1. Disable its onBeforeRender auto update and asynchronous
        // LoD work so no later update can overtake that completion boundary.
        this.spark = new SparkRenderer({ renderer: this.renderer, autoUpdate: false, enableLod: false, enableDriveLod: false, enableLodFetching: false, minSortIntervalMs: 0 });
        this.scene.add(this.spark);
        const splat = new SplatMesh({ url: assetUrl || this.assetUrl(environment.asset), lod: false, nonLod: true, enableLod: false });
        this.splat = splat;
        const root = new THREE.Group();
        this.alignWorld(root, environment.asset);
        root.add(splat);
        this.content.add(root);
        await splat.initialized;
        if (version !== this.loadVersion || this.disposed) return;
      }
      if (version !== this.loadVersion || this.disposed) return;
      this.loading = false;
      this.resize();
      this.setSelection(this.selectedId);
      if (this.spark && (capture || (!document.hidden && this.visible))) await this.render(true);
      else this.invalidate();
      if (version === this.loadVersion && !this.disposed) this.options.onReady?.();
    } catch (error: any) {
      if (version !== this.loadVersion || this.disposed) return;
      this.loading = false;
      this.options.onError?.(error?.message || String(error));
      throw error;
    }
  }

  private assetUrl(asset: any): string {
    const filename = String(asset?.path || '').split('/').pop();
    if (!filename || !/^[a-f0-9]{64}\.(glb|ply|spz)$/.test(filename)) throw new Error('The world asset path is invalid.');
    return `/api/assets/${filename}`;
  }

  async frame(sample: any): Promise<void> {
    if (this.disposed) throw new Error('Viewport has been disposed.');
    const request = ++this.frameRequest;
    // Explicit callers can await the exact submitted frame. Serializing Spark
    // updates prevents a later camera from overtaking a requested capture.
    const task = this.frameQueue.catch(() => {}).then(async () => {
      if (this.disposed || (!this.options.capture && request !== this.frameRequest)) return;
      for (const [id, pose] of Object.entries(sample.components || {}) as [string, any][]) {
        const component = this.components.get(id);
        if (!component) continue;
        component.position.fromArray(pose.translationM);
        component.quaternion.fromArray(pose.rotationXyzw);
      }
      const values = sample.camera;
      this.camera.position.fromArray(values.positionM);
      this.camera.lookAt(new THREE.Vector3().fromArray(values.targetM));
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(18 / values.focalLengthMm));
      this.camera.updateProjectionMatrix();
      this.selection?.update();
      if (!this.loading && (this.options.capture || (!document.hidden && this.visible))) await this.render(!!this.spark);
      else this.dirty = true;
    });
    this.frameQueue = task;
    return task;
  }

  private render(settle: boolean): Promise<void> {
    const version = this.loadVersion;
    const task = this.renderQueue.catch(() => {}).then(() => this.draw(settle, version));
    this.renderQueue = task;
    return task;
  }

  private async draw(settle: boolean, version: number): Promise<void> {
    if (this.disposed || version !== this.loadVersion) return;
    const spark = this.spark;
    this.content.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    if (spark) {
      this.renderer.getDrawingBufferSize(spark.renderSize);
      // With autoUpdate/LoD off and a serialized queue, update -> updateInternal
      // -> driveSort awaits GPU readback and sortWorker.call('sortSplats32'),
      // then publishes orderingTexture/display before this promise resolves.
      await spark.update({ scene: this.scene, camera: this.camera });
      if (this.disposed || version !== this.loadVersion) return;
      if (spark.sorting || spark.sortDirty || spark.sortTimeoutId !== undefined) {
        throw new Error('The Gaussian sort did not settle for the requested camera.');
      }
    }
    if (this.disposed || version !== this.loadVersion) return;
    this.renderer.render(this.scene, this.camera);
    if (settle) this.renderer.getContext().finish();
    this.dirty = false;
  }

  setSelection(id: string | null): void {
    this.selectedId = id;
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
      this.selection = null;
    }
    const component = id ? this.components.get(id) : undefined;
    if (component && !this.options.capture) {
      component.updateWorldMatrix(true, true);
      this.selection = new THREE.BoxHelper(component, 0xd8e7ad);
      this.scene.add(this.selection);
    }
    this.invalidate();
  }

  private disposeObject(root: THREE.Object3D): void {
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    const skeletons = new Set<THREE.Skeleton>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
      if (mesh.geometry) geometries.add(mesh.geometry);
      const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of values) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
    });
    textures.forEach(texture => texture.dispose());
    const images = new Set(Array.from(textures, texture => texture.image));
    images.forEach(image => { if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close(); });
    skeletons.forEach(skeleton => skeleton.dispose());
    materials.forEach(material => material.dispose());
    geometries.forEach(geometry => geometry.dispose());
  }

  private clearContent(): void {
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
      this.selection = null;
    }
    if (this.splat) { this.splat.dispose(); this.splat = null; }
    if (this.spark) { this.scene.remove(this.spark); this.spark.dispose(); this.spark = null; }
    this.disposeObject(this.content);
    this.content.clear();
    this.components.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadVersion++;
    this.cancelRender();
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.clearContent();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Host-based adapter used by the editor and the isolated /capture route. */
export function createViewport(host: HTMLElement, options: {
  onSelect?: (id: string | null) => void;
  onError?: (message: string) => void;
  capture?: boolean;
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  const previousPosition = host.style.position;
  let filmAspect = 9 / 16;
  if (!options.capture) {
    host.style.position = 'relative';
    canvas.style.position = 'absolute';
    canvas.style.left = '50%';
    canvas.style.top = '50%';
    canvas.style.transform = 'translate(-50%, -50%)';
  }
  if (options.capture) canvas.id = 'splat-capture';
  host.appendChild(canvas);
  const fitCanvas = () => {
    if (options.capture) return;
    const height = Math.min(host.clientHeight, host.clientWidth / filmAspect);
    canvas.style.width = `${height * filmAspect}px`;
    canvas.style.height = `${height}px`;
  };
  fitCanvas();
  const viewport = new StudioViewport(canvas, options);
  const hostObserver = new ResizeObserver(() => { fitCanvas(); viewport.resize(); });
  hostObserver.observe(host);
  let version = 0;
  let captureFrames: any[] = [];
  let latestSample: any = null;
  return {
    async setScene(scene: any, sample: any) {
      const request = ++version;
      latestSample = sample;
      filmAspect = scene.render.width / scene.render.height;
      fitCanvas();
      await viewport.load(scene);
      if (request === version && latestSample) await viewport.frame(latestSample);
    },
    setSample(sample: any) {
      latestSample = sample;
      return viewport.frame(sample).catch(error => {
        if (!options.onError) throw error;
        options.onError(String(error?.message || error));
      });
    },
    setSelected(id: string | null) { viewport.setSelection(id); },
    resize() { fitCanvas(); viewport.resize(); },
    dispose() {
      version++;
      hostObserver.disconnect();
      viewport.dispose();
      canvas.remove();
      if (!options.capture && host.style.position === 'relative') host.style.position = previousPosition;
    },
    async loadCapture(payload: {scene: any; frames: any[]; width: number; height: number; assetUrl: string}) {
      if (!options.capture) throw new Error('This viewport is not a capture viewport.');
      if (!Number.isInteger(payload.width) || !Number.isInteger(payload.height) || payload.width <= 0 || payload.height <= 0) {
        throw new Error('Capture dimensions must be positive integers.');
      }
      canvas.width = payload.width;
      canvas.height = payload.height;
      canvas.style.width = `${payload.width}px`;
      canvas.style.height = `${payload.height}px`;
      captureFrames = payload.frames;
      await viewport.load(payload.scene, payload.assetUrl);
    },
    async captureFrame(frameNumber: number) {
      const sample = captureFrames.find(frame => frame.frame === frameNumber);
      if (!sample) throw new Error(`Sampled frame ${frameNumber} is unavailable.`);
      await viewport.frame(sample);
    },
  };
}
