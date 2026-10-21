import * as THREE from 'three';
import {createComponentGeometry, loadVerifiedGlb, prepareImportedMesh, disposeSceneObject, sceneAssetUrl} from './sceneObjects';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import type { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { hasUvOverlap, projectDecalTriangle, uvBarycentricWeights, type ProductDecal, type SurfaceTriangle, type UvLayout } from './decals';
import { createSurfaceMaterial, disposeSurfaceMaterial, loadMaterialTextures, type MaterialHover, type MaterialPreview, type MaterialSpecification } from './materials';
import { createTransformPointerGesture, type TransformGesture, type TransformPointer } from './transformPointer';
import type { TransformTarget } from './transforms';
import {DepthOfFieldPreview} from './DepthOfFieldPreview';
import {sampledDepthOfField, sparkApertureAngle, type DepthOfFieldSample} from './focusOptics';
import {FilmImageRenderer, type FilmClip} from './FilmImageRenderer';
import {createCameraTargetPointerGesture, filmGateRect, filmGuideZoom, projectFilmGuide, type CameraTargetGesture, type CameraTargetPointer, type FilmGuideProjection} from './filmGuides';

// The lookup textures are shared across both comparison renderers.
let areaLightUniformsReady = false;

export type WorldPointPick = {
  sourcePoint: [number, number, number];
  worldPoint: [number, number, number];
};

export type ViewportPart = {
  id: string;
  componentId: string;
  name: string;
  parentId: string | null;
  source: 'scene' | 'glb';
  sourceName: string;
  sourcePath?: string;
  dimensionsM?: [number, number, number];
  materialSlots?: { id: string; name: string }[];
};

export type ViewportOptions = {
  capture?: boolean;
  studioMode?: boolean;
  onSelect?: (id: string) => void;
  onParts?: (parts: ViewportPart[]) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  /** Once per load, after a complete sampled frame has reached the canvas. */
  onPresented?: () => void;
  /** Remains busy until the first sampled frame is displayed, including GPU sorting. */
  onLoading?: (loading: boolean) => void;
  onWorldPoint?: (point: WorldPointPick) => void;
  onInteract?: () => void;
  onFilmGuide?: (guide: FilmGuideProjection | null) => void;
};

type MaterialPreviewState = {
  descriptor: MaterialPreview | null;
  revision: number;
  abort: AbortController | null;
  applied: { material: THREE.MeshPhysicalMaterial; originals: Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }> } | null;
  pending: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null;
  running: { revision: number; loadVersion: number; promise: Promise<void> } | null;
};

/** The browser only consumes poses sampled by film.scene; it evaluates no motion. */
export class StudioViewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 9 / 16, 0.001, 100);
  private readonly content = new THREE.Group();
  private readonly components = new Map<string, THREE.Group>();
  private readonly environmentObjects = new Map<THREE.Object3D, boolean>();
  private environmentBackground: THREE.Color | null = null;
  private environmentMap: THREE.WebGLRenderTarget | null = null;
  private productPreview = false;
  private filmContent = false;
  private filmClip: FilmClip = {kind: 'scene'};
  private imageRenderer: FilmImageRenderer | null = null;
  private productGround: THREE.Mesh | null = null;
  /** Studio lights by scene ID, so sampled light poses can move them per frame.
   * Created on first use: test harnesses build viewports from the prototype. */
  private studioLights: Map<string, {light: THREE.RectAreaLight | THREE.SpotLight; target: THREE.Object3D | null; shadow: THREE.DirectionalLight | null}> | null = null;
  private rigLights() { return this.studioLights ??= new Map(); }
  private readonly parts = new Map<string, THREE.Object3D>();
  private readonly originalVisibility = new Map<THREE.Object3D, boolean>();
  private readonly focusMaterials = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }>();
  private readonly previewMaterials = new Set<THREE.Material>();
  private uvProbePartId: string | null = null;
  private uvProbeSources: { mesh: THREE.Mesh; buckets: Map<string, number[]>; wide: number[] }[] = [];
  private uvProbeSprites: THREE.Sprite[] = [];
  private uvProbeMaterial: THREE.SpriteMaterial | null = null;
  private surfaceSpecifications = new WeakMap<THREE.MeshPhysicalMaterial, MaterialSpecification>();
  private hiddenParts = new Set<string>();
  private focusPartIds: string[] = [];
  private materialHover: MaterialHover | null = null;
  private partFocus = false;
  private framedSelection = false;
  private framedWorldObjectId: string | null = null;
  private inspectingCamera = false;
  private inspectionEnabled = true;
  private filmGuides = false;
  private presentationVersion = 0;
  private sampledOptics: DepthOfFieldSample | null = null;
  private depthOfFieldPreview: DepthOfFieldPreview | null = null;
  private filmOutputAspect = 9 / 16;
  private presentedFilm: {camera: THREE.PerspectiveCamera; target: THREE.Vector3} | null = null;
  private sampledCamera: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number; target: THREE.Vector3 } | null = null;
  private controls: OrbitControls | null = null;
  private interactionSurface: HTMLElement | null = null;
  private controlSurface: { element: HTMLElement; cursor: string; touchAction: string; pointers: Set<number>; down: (event: PointerEvent) => void; end: (event: PointerEvent) => void } | null = null;
  private controlListeners: { start: () => void; change: () => void; end: () => void } | null = null;
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
  private unpresentedLoadVersion: number | null = null;
  private sampledLoadVersion = -1;
  private loading = false;
  private loadFailed = false;
  private awaitingSample = false;
  private pendingSize: { width: number; height: number } | null = null;
  private renderedSize: { width: number; height: number } | null = null;
  private liveRender: Promise<void> | null = null;
  private frameQueue: Promise<void> = Promise.resolve();
  private renderQueue: Promise<void> = Promise.resolve();
  private frameRequest = 0;
  private assetAbort: AbortController | null = null;
  private worldRoot: THREE.Group | null = null;
  private worldLoadVersion = -1;
  private worldReady = false;
  private worldPickEnabled = false;
  private loadedProductKey: string | null = null;
  private materialPreviewState: MaterialPreviewState | null = null;
  private transformPlacement: { pivot: THREE.Vector3; scale: number } | null = null;

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
    this.resizeObserver = new ResizeObserver(() => this.resize());
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
    this.createControls();
    this.resize();
  }

  private createControls(target = new THREE.Vector3(0, .073, 0)): void {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    const element = this.interactionSurface ?? this.canvas;
    const pointers = new Set<number>();
    const down = (event: PointerEvent) => { if (this.controls?.enabled) pointers.add(event.pointerId); };
    const end = (event: PointerEvent) => { pointers.delete(event.pointerId); };
    this.controlSurface = { element, cursor: element.style.cursor, touchAction: element.style.touchAction, pointers, down, end };
    // Track only events that reach this surface. Decal capture handlers claim
    // artwork drags before these native camera listeners run.
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener('lostpointercapture', end);
    const controls = new OrbitControls(this.camera, element);
    this.controls = controls;
    // No damping or auto-rotation: pointer/wheel changes invalidate exactly
    // when needed, and no animation loop runs after the gesture ends.
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.minDistance = this.camera.near * 4;
    controls.maxDistance = this.camera.far * .5;
    controls.target.copy(target);
    controls.update();
    this.controlListeners = { start: this.onControlsStart.bind(this), change: this.onControlsChange.bind(this), end: this.onControlsEnd.bind(this) };
    controls.addEventListener('start', this.controlListeners.start);
    controls.addEventListener('change', this.controlListeners.change);
    controls.addEventListener('end', this.controlListeners.end);
    this.updateControlsEnabled();
  }

  private updateControlsEnabled(): void {
    if (this.controls) this.controls.enabled = this.inspectionEnabled && !(this.filmContent && this.filmClip?.kind !== 'scene') && !this.disposed && !this.loading && !this.loadFailed && !this.awaitingSample && !this.worldPickEnabled && this.parts.size > 0;
    (this.controlSurface?.element ?? this.canvas).style.cursor = this.worldPickEnabled ? 'crosshair' : this.controls?.enabled ? 'grab' : '';
  }

  private onControlsStart(): void {
    if (!this.controls?.enabled) return;
    this.inspectingCamera = true;
    this.framedSelection = false;
    this.framedWorldObjectId = null;
    (this.controlSurface?.element ?? this.canvas).style.cursor = 'grabbing';
    this.options.onInteract?.();
  }

  private onControlsChange(): void { this.invalidate(); }
  private onControlsEnd(): void { this.updateControlsEnabled(); }

  private disposeControls(): void {
    if (!this.controls) return;
    if (this.controlListeners) {
      this.controls.removeEventListener('start', this.controlListeners.start);
      this.controls.removeEventListener('change', this.controlListeners.change);
      this.controls.removeEventListener('end', this.controlListeners.end);
      this.controlListeners = null;
    }
    this.controls.dispose();
    this.controls = null;
    const surface = this.controlSurface;
    this.controlSurface = null;
    if (surface) {
      const { element, pointers, down, end } = surface;
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      element.removeEventListener('lostpointercapture', end);
      // OrbitControls.disconnect leaves tracked pointers behind; disposing the
      // instance and releasing its captures makes a mid-gesture swap recover.
      for (const pointerId of pointers) {
        if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      }
      element.style.cursor = surface.cursor;
      element.style.touchAction = surface.touchAction;
    }
  }

  /** Let a viewport overlay share native orbit/pan/zoom without forwarding events. */
  setInteractionSurface(element: HTMLElement | null): void {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    if ((element ?? this.canvas) === (this.interactionSurface ?? this.canvas)) return;
    const target = this.controls?.target.clone() ?? new THREE.Vector3(0, .073, 0);
    const position = this.camera.position.clone(), quaternion = this.camera.quaternion.clone();
    const zoom = this.camera.zoom;
    this.disposeControls();
    this.interactionSurface = element;
    this.createControls(target);
    // Construction updates OrbitControls against its default target. Restore
    // the exact preview pose; swapping input surfaces is not a camera edit.
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    this.camera.zoom = zoom;
    this.camera.updateMatrixWorld(true);
  }

  private onVisibility = () => {
    if (document.hidden) this.cancelRender();
    else if (this.dirty) this.invalidate();
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.options.onLoading?.(false);
    this.options.onError?.('The 3D graphics context was lost. Reopen this project to restore the preview.');
  };

  private onPointerUp = (event: PointerEvent) => { this.pickAtPointer(event); };

  private pickAtPointer(event: PointerEvent): void {
    if (this.options.capture || this.disposed || event.button !== 0) return;
    // Calibration never falls through to product selection, including while a
    // replacement world is loading or when the pointer misses its geometry.
    const world = this.worldRoot;
    if (this.worldPickEnabled && (!world || this.loading || this.loadFailed || this.awaitingSample || !this.worldReady
        || this.worldLoadVersion !== this.loadVersion || world.parent !== this.content
        || document.hidden || !this.visible || !this.objectVisible(world))) return;
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || event.clientX < bounds.left || event.clientY < bounds.top
        || event.clientX > bounds.left + bounds.width || event.clientY > bounds.top + bounds.height) return;
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.worldPickEnabled) {
      // Only the imported world hierarchy participates. Explicit plinth/props,
      // exact product geometry and selection helpers cannot become references.
      world!.updateWorldMatrix(true, true);
      const determinant = world!.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) return;
      const meshes: THREE.Mesh[] = [];
      world!.traverseVisible(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
      for (const hit of this.raycaster.intersectObjects(meshes, false)) {
        const mesh = hit.object as THREE.Mesh;
        const surface = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
        if (!surface?.visible || (surface.transparent && surface.opacity <= 0)) continue;
        // Invert only the alignment root. The GLB scene's internal transforms
        // remain part of the raw source point, rather than returning mesh-local
        // coordinates or dividing world Y by scale without undoing rotation.
        const source = world!.worldToLocal(hit.point.clone());
        if (![source.x, source.y, source.z, hit.point.x, hit.point.y, hit.point.z].every(Number.isFinite)) return;
        this.options.onWorldPoint?.({ sourcePoint: [source.x, source.y, source.z],
          worldPoint: [hit.point.x, hit.point.y, hit.point.z] });
        return;
      }
      return;
    }
    // In the studio the image operates the active layer. Part selection lives
    // in the persistent tree, so clicking the specimen never changes layers.
    if (this.options.studioMode) return;
    const hits = this.raycaster.intersectObjects([...this.components.values()], true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && !node.userData.componentId) node = node.parent;
      if (node?.userData.componentId) {
        this.options.onSelect?.(node.userData.componentId);
        return;
      }
    }
  }

  private objectVisible(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  setWorldPickEnabled(enabled: boolean): void {
    this.worldPickEnabled = !!enabled && !this.disposed && !this.options.capture;
    this.updateControlsEnabled();
  }

  setInspectionEnabled(enabled: boolean): void {
    this.inspectionEnabled = !!enabled;
    this.updateControlsEnabled();
  }

  /** Product inspection changes presentation only, never the authored scene. */
  setProductPreview(enabled: boolean): void {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    if (this.productPreview === enabled) return;
    this.productPreview = enabled;
    this.presentationVersion = (this.presentationVersion ?? 0) + 1;
    this.applyProductPreview();
    if (this.framedSelection) this.fitSelection();
    this.invalidate();
  }

  private applyProductPreview(): void {
    if (!this.options.studioMode || this.options.capture) return;
    this.scene.background = this.productPreview ? new THREE.Color(0xffffff) : this.environmentBackground;
    for (const [object, visible] of this.environmentObjects) object.visible = !this.productPreview && visible;
    if (this.productGround) this.productGround.visible = this.productPreview;
    if (this.spark) this.spark.visible = !this.productPreview;
  }

  private addEnvironmentObject(object: THREE.Object3D): void {
    this.environmentObjects.set(object, object.visible);
    this.content.add(object);
  }

  setFilmContent(enabled: boolean): void {
    if (this.filmContent === enabled) return;
    this.filmContent = enabled; this.presentationVersion++;
    this.updateControlsEnabled(); this.invalidate();
  }

  setFilmGuides(enabled: boolean): void {
    const next = !!enabled && !!this.options.studioMode && !this.options.capture && !this.disposed;
    if (this.filmGuides === next) return;
    this.filmGuides = next;
    this.presentationVersion = (this.presentationVersion ?? 0) + 1;
    this.presentedFilm = null;
    if (!next) this.options.onFilmGuide?.(null);
    this.applyFilmProjection(this.camera, this.pendingSize);
    this.invalidate();
  }

  private applyFilmProjection(camera: THREE.PerspectiveCamera, size: {width: number; height: number} | null): void {
    camera.zoom = this.filmGuides && !this.options.capture && size
      ? filmGuideZoom(size.width, size.height, this.filmOutputAspect) : 1;
    camera.updateProjectionMatrix();
  }

  createCameraTargetGesture(pointer: CameraTargetPointer): CameraTargetGesture | null {
    if (!this.filmGuides || !this.presentedFilm || this.disposed || this.loading || this.loadFailed || this.awaitingSample || this.options.capture) return null;
    return createCameraTargetPointerGesture(this.presentedFilm.camera, this.canvas.getBoundingClientRect(), this.presentedFilm.target, pointer);
  }

  resize(): void {
    if (this.disposed) return;
    // CSS can resize the visible image immediately. Keep its drawing buffer
    // intact until draw() can replace it with a complete frame at the new size.
    const width = Math.round(this.options.capture ? this.canvas.width : this.canvas.clientWidth);
    const height = Math.round(this.options.capture ? this.canvas.height : this.canvas.clientHeight);
    // A collapsed comparison pane must not erase its last useful frame.
    if (width <= 0 || height <= 0) return;
    if (this.pendingSize?.width === width && this.pendingSize.height === height) return;
    this.pendingSize = { width, height };
    this.camera.aspect = width / height;
    this.applyFilmProjection(this.camera, this.pendingSize);
    this.updateUvProbeScale();
    if (this.framedSelection) this.fitSelection();
    this.invalidate();
  }

  private cancelRender(): void {
    if (this.pendingRender) cancelAnimationFrame(this.pendingRender);
    this.pendingRender = 0;
  }

  private canDraw(): boolean {
    return !this.disposed && !this.loading && !this.loadFailed && !this.awaitingSample
      && (this.options.capture || (!document.hidden && this.visible));
  }

  private invalidate(): void {
    this.dirty = true;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (!this.dirty || !this.canDraw() || this.options.capture || this.pendingRender || this.liveRender) return;
    this.pendingRender = requestAnimationFrame(() => {
      this.pendingRender = 0;
      const version = this.loadVersion;
      void this.render(false).catch(error => {
        if (!this.disposed && version === this.loadVersion) {
          this.options.onLoading?.(false);
          this.options.onError?.(String(error?.message || error));
        }
      });
    });
  }

  private color(values: number[]): THREE.Color {
    // Scene baseColor values are linear, matching Blender's shader inputs.
    return new THREE.Color().setRGB(values[0], values[1], values[2], THREE.LinearSRGBColorSpace);
  }

  private surface(specification: MaterialSpecification): THREE.MeshPhysicalMaterial {
    const material = createSurfaceMaterial(specification);
    // Keep source bindings outside renderer metadata; copied focus materials
    // share the resulting textures, without owning another async load.
    this.surfaceSpecifications ||= new WeakMap();
    this.surfaceSpecifications.set(material, specification);
    return material;
  }

  private async loadSurfaceTextures(signal: AbortSignal): Promise<void> {
    if (!this.surfaceSpecifications) return;
    const materials = new Set<THREE.MeshPhysicalMaterial>();
    this.content.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof THREE.MeshPhysicalMaterial && this.surfaceSpecifications.has(material)) materials.add(material);
      }
    });
    const results = await Promise.allSettled([...materials].map(async material => {
      const specification = this.surfaceSpecifications.get(material)!;
      if (Object.keys(specification.textures || {}).length) await loadMaterialTextures(material, specification, asset => this.assetUrl(asset), { signal });
      this.surfaceSpecifications.delete(material);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private geometry(shape: string, size: number[], bevel = 0): THREE.BufferGeometry {
    return createComponentGeometry(shape, size, bevel);
  }

  private async makeProduct(source: any, version: number, signal: AbortSignal): Promise<void> {
    const support = source.environment?.plinth;
    const pivot = new THREE.Vector3().fromArray(source.placement.translationM);
    if (support) pivot.add(new THREE.Vector3().fromArray(support.translationM)).add(new THREE.Vector3(0, support.sizeM[1] / 2, 0));
    this.transformPlacement = { pivot, scale: source.placement.scale ?? 1 };
    for (const specification of source.product.components) {
      if (version !== this.loadVersion || this.disposed) return;
      const group = new THREE.Group();
      group.name = specification.id;
      group.userData.componentId = specification.id;
      group.userData.gessoPrimitiveShape = specification.shape;
      group.userData.gessoMaterialOverride = specification.materialOverride === true;
      group.userData.gessoAssemblyRotation = [...specification.assembly.rotationXyzw];
      if (specification.shape === 'mesh') {
        const imported = await this.loadVerifiedGlb(specification.asset, signal);
        if (version !== this.loadVersion || this.disposed) { this.disposeObject(imported); return; }
        this.prepareImportedMesh(imported);
        try { this.applyProductMaterials(imported, specification, source.product.materialPresets || []); }
        catch (error) { this.disposeObject(imported); throw error; }
        // Mesh coordinates are already centered and measured in meters. Keep
        // every imported node transform and never resize geometry to sizeM.
        group.add(imported);
      } else {
        const mesh = new THREE.Mesh(this.geometry(specification.shape, specification.sizeM, specification.bevelM), this.surface(specification.material));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      const productScale = source.placement.scale ?? 1;
      group.position.fromArray(specification.assembly.translationM).multiplyScalar(productScale);
      group.position.add(new THREE.Vector3().fromArray(source.placement.translationM));
      group.quaternion.fromArray(specification.assembly.rotationXyzw);
      // Scale the component root, preserving imported node transforms and
      // source UVs while letting attached artwork follow the same surface.
      group.scale.setScalar(productScale * (specification.assembly.scale ?? 1));
      this.components.set(specification.id, group);
      this.content.add(group);
    }
    // Decode every declared map before indexing parts, cloning focus materials,
    // or allowing a sampled frame to publish the replacement product.
    await this.loadSurfaceTextures(signal);
    if (version !== this.loadVersion || this.disposed) return;
    const label = source.product.label;
    if (label && this.components.has(label.componentId) && !(source.product.decals || []).some((decal: ProductDecal) => decal.componentId === label.componentId)) {
      const component = source.product.components.find((item: any) => item.id === label.componentId);
      this.addLabel(this.components.get(label.componentId)!, label, component.sizeM);
    }
    this.indexProductParts(source);
    this.addDecals(source.product.decals || []);
    // Decals are children of their source meshes: animation and part focus
    // affect ink with its part, without adding artwork to the assembly tree.
    for (const component of this.components.values()) component.traverse(object => this.originalVisibility.set(object, object.visible));
    this.applyPartPreview();
  }

  private indexProductParts(source: any): void {
    const records: ViewportPart[] = [];
    for (const specification of source.product.components) {
      const root = this.components.get(specification.id);
      if (!root) continue;
      this.parts.set(specification.id, root);
      records.push({ id: specification.id, componentId: specification.id,
        name: specification.name || specification.id, parentId: null, source: 'scene',
        sourceName: specification.id,
        dimensionsM: specification.sizeM.map((value: number) => value * root.scale.x) as [number, number, number],
        materialSlots: this.materialSlots(root, specification.id) });
      const visit = (object: THREE.Object3D, parentId: string) => {
        if (object.userData.gessoArtwork) return;
        const sourceNode = object.userData.gessoSourceNode as { index: number; name: string } | undefined;
        let currentParent = parentId;
        if (sourceNode) {
          const id = `${specification.id}::node:${sourceNode.index}`;
          this.parts.set(id, object);
          records.push({ id, componentId: specification.id, name: sourceNode.name,
            parentId, source: 'glb', sourceName: sourceNode.name, sourcePath: `nodes[${sourceNode.index}]`,
            dimensionsM: this.localDimensions(object), materialSlots: this.materialSlots(object, specification.id) });
          currentParent = id;
        }
        for (const child of object.children) visit(child, currentParent);
      };
      for (const child of root.children) visit(child, specification.id);
      root.traverse(object => this.originalVisibility.set(object, object.visible));
    }
    this.rebuildUvProbeIndex();
    this.applyPartPreview();
    this.options.onParts?.(records);
  }

  private localDimensions(root: THREE.Object3D): [number, number, number] | undefined {
    root.updateWorldMatrix(true, true);
    if (Math.abs(root.matrixWorld.determinant()) < Number.EPSILON) return undefined;
    const inverse = root.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.computeBoundingBox();
      if (object.geometry.boundingBox) box.union(object.geometry.boundingBox.clone()
        .applyMatrix4(inverse.clone().multiply(object.matrixWorld)));
    });
    return box.isEmpty() ? undefined : box.getSize(new THREE.Vector3()).toArray() as [number, number, number];
  }

  private materialSlots(root: THREE.Object3D, componentId: string): { id: string; name: string }[] {
    const materials = new Map<THREE.Material, { id: string; name: string }>();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object.userData.gessoArtwork) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (materials.has(material)) continue;
        const index = material.userData.gessoSourceMaterial ?? materials.size;
        materials.set(material, { id: `${componentId}::material:${index}`,
          name: material.userData.gessoSourceMaterialName || material.name || `Material ${Number(index) + 1}` });
      }
    });
    return [...new Map([...materials.values()].map(slot => [slot.id, slot])).values()];
  }

  private prepareImportedMesh(root: THREE.Object3D): void {
    prepareImportedMesh(root);
  }

  private overrideMaterial(root: THREE.Object3D, specification: any): void {
    const replacement = this.surface(specification);
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      object.material = replacement;
    });
    textures.forEach(texture => texture.dispose());
    const images = new Set(Array.from(textures, texture => texture.image));
    images.forEach(image => { if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close(); });
    materials.forEach(material => material.dispose());
  }

  /** Apply section bindings once, against original glTF node handles. A child
   * binding wins over its parent; untouched siblings retain their native slots. */
  private applyProductMaterials(root: THREE.Object3D, component: any, presets: any[]): void {
    const bindings = new Map<number, string>();
    const materialsByPreset = new Map<string, MaterialSpecification>(presets.map(preset => [preset.id, preset.material]));
    const nodes = new Set<number>();
    root.traverse(object => {
      const index = object.userData.gessoSourceNode?.index;
      if (Number.isInteger(index)) nodes.add(index);
    });
    // Resolve every binding before replacing anything, including hidden nodes.
    for (const binding of component.materialBindings || []) {
      if (!Number.isInteger(binding.nodeIndex) || !nodes.has(binding.nodeIndex)) {
        throw new Error(`The material section nodes[${binding.nodeIndex}] is missing from ${component.id}.`);
      }
      if (!materialsByPreset.has(binding.materialPresetId)) {
        throw new Error(`The material preset ${binding.materialPresetId} is missing.`);
      }
      if (bindings.has(binding.nodeIndex)) throw new Error(`The material section nodes[${binding.nodeIndex}] has more than one assignment.`);
      bindings.set(binding.nodeIndex, binding.materialPresetId);
    }
    const originals = new Set<THREE.Material>();
    const replacements = new Map<MaterialSpecification, Map<THREE.Material, THREE.Material>>();
    const replace = (original: THREE.Material, specification: MaterialSpecification) => {
      let bySource = replacements.get(specification);
      if (!bySource) { bySource = new Map(); replacements.set(specification, bySource); }
      let replacement = bySource.get(original);
      if (!replacement) {
        replacement = this.surface(specification);
        if (original.userData.gessoSourceMaterial !== undefined) replacement.userData.gessoSourceMaterial = original.userData.gessoSourceMaterial;
        replacement.userData.gessoSourceMaterialName = original.userData.gessoSourceMaterialName || original.name;
        bySource.set(original, replacement);
      }
      originals.add(original);
      return replacement;
    };
    const visit = (object: THREE.Object3D, inherited: MaterialSpecification | undefined) => {
      if (object.userData.gessoArtwork) return;
      delete object.userData.gessoMaterialBindingPresetId;
      const presetId = bindings.get(object.userData.gessoSourceNode?.index);
      const material = presetId === undefined ? inherited : materialsByPreset.get(presetId);
      if (presetId !== undefined) object.userData.gessoMaterialBindingPresetId = presetId;
      if (material && object instanceof THREE.Mesh) {
        object.material = Array.isArray(object.material)
          ? object.material.map(original => replace(original, material))
          : replace(object.material, material);
      }
      for (const child of object.children) visit(child, material);
    };
    visit(root, component.materialOverride === true ? component.material : undefined);
    // Imported meshes can share one material or texture. Replacing a section
    // must not dispose a resource that a sibling still uses.
    const retained = new Set<THREE.Material>(), retainedTextures = new Set<THREE.Texture>();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        retained.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) retainedTextures.add(value);
      }
    });
    const disposedTextures = new Set<THREE.Texture>();
    for (const material of originals) {
      if (retained.has(material)) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !retainedTextures.has(value)) disposedTextures.add(value);
      }
      material.dispose();
    }
    const retainedImages = new Set(Array.from(retainedTextures, texture => texture.image));
    for (const texture of disposedTextures) texture.dispose();
    for (const image of new Set(Array.from(disposedTextures, texture => texture.image))) {
      if (!retainedImages.has(image) && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    }
  }

  private async loadVerifiedGlb(asset: any, signal: AbortSignal, url?: string): Promise<THREE.Group> {
    return loadVerifiedGlb(asset, signal, url);
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
    plane.userData.gessoArtwork = true;
    plane.position.z = size[2] / 2 + 0.00012;
    parent.add(plane);
  }

  private sourceMeshes(root: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    root.traverse(object => { if (object instanceof THREE.Mesh && !object.userData.gessoArtwork) meshes.push(object); });
    return meshes;
  }

  /** Decal hover is an editor overlay; it never alters canonical materials or picks a part. */
  setUvProbePart(partId: string | null): void {
    this.clearUvProbe();
    this.uvProbePartId = this.options.studioMode && !this.options.capture ? partId : null;
    this.rebuildUvProbeIndex();
    this.applyPartPreview();
    this.invalidate();
  }

  private clearUvProbe(): void {
    for (const sprite of this.uvProbeSprites || []) sprite.removeFromParent();
    this.uvProbeSprites = [];
  }

  private rebuildUvProbeIndex(): void {
    this.uvProbeSources = [];
    const root = this.uvProbePartId ? this.parts.get(this.uvProbePartId) : null;
    if (!root) return;
    for (const mesh of this.sourceMeshes(root)) {
      const geometry = mesh.geometry, uv = geometry.getAttribute('uv'), position = geometry.getAttribute('position');
      if (!uv || !position) continue;
      const buckets = new Map<string, number[]>(), wide: number[] = [];
      const count = geometry.index?.count ?? position.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const indices = [0, 1, 2].map(j => geometry.index?.getX(i + j) ?? i + j);
        const values = indices.flatMap(j => [uv.getX(j), uv.getY(j)]);
        if (values.some(value => !Number.isFinite(value))) continue;
        const minU = Math.min(values[0], values[2], values[4]), maxU = Math.max(values[0], values[2], values[4]);
        const minV = Math.min(values[1], values[3], values[5]), maxV = Math.max(values[1], values[3], values[5]);
        if (maxU < 0 || minU > 1 || maxV < 0 || minV > 1) continue;
        // The overlay exposes the 0–1 tile. Clamp bins before integer iteration:
        // arbitrary finite GLB UVs can otherwise exceed JS's incrementable integers.
        const x0 = Math.floor(Math.max(0, minU) * 16), x1 = Math.floor(Math.min(1, maxU) * 16);
        const y0 = Math.floor(Math.max(0, minV) * 16), y1 = Math.floor(Math.min(1, maxV) * 16);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { wide.push(i); continue; }
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const key = `${x}:${y}`, bucket = buckets.get(key) || [];
          bucket.push(i); buckets.set(key, bucket);
        }
      }
      this.uvProbeSources.push({ mesh, buckets, wide });
    }
  }

  private probeMaterial(): THREE.SpriteMaterial {
    if (this.uvProbeMaterial) return this.uvProbeMaterial;
    const size = 64, pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const radius = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
      const radiusPx = radius * 9;
      // Solid 4 px center and a 1.5 px ring, with only edge antialiasing.
      const coverage = (distance: number) => THREE.MathUtils.clamp(distance / .4 + .5, 0, 1);
      const alpha = Math.max(coverage(2 - radiusPx), coverage(Math.min(radiusPx - 5.5, 7 - radiusPx)));
      const offset = (y * size + x) * 4;
      pixels.set([255, 255, 255, Math.round(alpha * 255)], offset);
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    this.uvProbeMaterial = new THREE.SpriteMaterial({ map: texture, color: 0xff2020,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false });
    return this.uvProbeMaterial;
  }

  setUvProbe(uv: [number, number] | null): void {
    this.clearUvProbe();
    if (!uv || uv.some(value => !Number.isFinite(value) || value < 0 || value > 1) || !this.uvProbePartId || this.disposed || this.loading || this.loadFailed || this.awaitingSample
        || !this.options.studioMode || this.options.capture) { this.invalidate(); return; }
    const key = `${Math.floor(uv[0] * 16)}:${Math.floor(uv[1] * 16)}`;
    const worldHits: THREE.Vector3[] = [];
    for (const source of this.uvProbeSources || []) {
      const { mesh } = source, geometry = mesh.geometry;
      if (!this.objectVisible(mesh)) continue;
      const coordinates = geometry.getAttribute('uv'), positions = geometry.getAttribute('position');
      mesh.updateWorldMatrix(true, false);
      for (const start of [...(source.buckets.get(key) || []), ...source.wide]) {
        const indices = [0, 1, 2].map(j => geometry.index?.getX(start + j) ?? start + j);
        const weights = uvBarycentricWeights(indices.flatMap(j => [coordinates.getX(j), coordinates.getY(j)]), uv);
        if (!weights) continue;
        const position = new THREE.Vector3();
        indices.forEach((index, vertex) => position.addScaledVector(new THREE.Vector3().fromBufferAttribute(positions, index), weights[vertex]));
        const world = position.clone().applyMatrix4(mesh.matrixWorld);
        // Shared edges produce one marker; genuinely stacked UV islands retain all distinct surfaces.
        if (worldHits.some(hit => hit.distanceToSquared(world) < 1e-14)) continue;
        worldHits.push(world);
        const sprite = new THREE.Sprite(this.probeMaterial());
        sprite.name = 'UV surface probe'; sprite.renderOrder = 1000; sprite.userData.gessoArtwork = true; sprite.userData.gessoUvProbe = true;
        sprite.position.copy(position); mesh.add(sprite); this.uvProbeSprites.push(sprite);
      }
    }
    this.updateUvProbeScale();
    this.invalidate();
  }

  private updateUvProbeScale(): void {
    if (!this.uvProbeSprites?.length) return;
    // Sprite sizeAttenuation=false keeps an 18 CSS-pixel marker independent of model size or zoom.
    const size = 36 / Math.max(1, this.canvas.clientHeight) / this.camera.projectionMatrix.elements[5];
    for (const sprite of this.uvProbeSprites) {
      const parentScale = sprite.parent!.getWorldScale(new THREE.Vector3());
      sprite.scale.set(size / Math.max(1e-12, Math.abs(parentScale.x)), size / Math.max(1e-12, Math.abs(parentScale.y)), 1);
    }
  }

  getUvLayout(partId: string): UvLayout {
    const root = this.parts.get(partId);
    const triangles: number[][] = [];
    let triangleCount = 0, missing = 0;
    if (root) for (const mesh of this.sourceMeshes(root)) {
      const geometry = mesh.geometry, uv = geometry.getAttribute('uv'), position = geometry.getAttribute('position');
      if (!uv || !position) { missing++; continue; }
      const count = geometry.index?.count ?? position.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const indices = [0, 1, 2].map(j => geometry.index?.getX(i + j) ?? i + j);
        const t = indices.flatMap(j => [uv.getX(j), uv.getY(j)]);
        if (t.some(n => !Number.isFinite(n)) || Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0])) < 1e-12) continue;
        triangleCount++;
        if (triangles.length < 6000) triangles.push(t);
      }
    }
    const box = root?.userData.gessoPrimitiveShape === 'box';
    return { partId, triangles, triangleCount, missingUv: triangleCount === 0, partialUv: missing > 0 && triangleCount > 0,
      overlap: hasUvOverlap(triangles), truncated: triangleCount > triangles.length,
      suggestedCenterUv: box ? [.5, .75] : [.5, .5], suggestedSizeUv: box ? [.28, .36] : [.3, .2] };
  }

  private addDecals(decals: ProductDecal[]): void {
    this.content.updateWorldMatrix(true, true);
    for (const decal of decals) {
      const root = this.parts.get(decal.partId);
      if (!root || !this.components.has(decal.componentId)) continue;
      const patches: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
      let aspect = 1, nearest = Infinity;
      for (const mesh of this.sourceMeshes(root)) {
        const source = mesh.geometry, positions = source.getAttribute('position'), normals = source.getAttribute('normal'), uv = source.getAttribute('uv');
        if (!positions || !uv || Math.abs(mesh.matrixWorld.determinant()) < Number.EPSILON) continue;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        const output = { positions: [] as number[], normals: [] as number[], uvs: [] as number[] };
        const count = source.index?.count ?? positions.count;
        for (let i = 0; i + 2 < count; i += 3) {
          const indices = [0, 1, 2].map(j => source.index?.getX(i + j) ?? i + j);
          const points = indices.map(j => new THREE.Vector3().fromBufferAttribute(positions, j).applyMatrix4(mesh.matrixWorld));
          const faceNormal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
          const triangle = indices.map((j, k) => ({ position: points[k].toArray(),
            normal: (normals ? new THREE.Vector3().fromBufferAttribute(normals, j).applyNormalMatrix(normalMatrix) : faceNormal).toArray(),
            uv: [uv.getX(j), uv.getY(j)] })) as SurfaceTriangle;
          const projection = projectDecalTriangle(triangle, decal);
          if (!projection.positions.length) continue;
          // Concatenation avoids spread argument limits on dense imported meshes.
          for (const key of ['positions', 'normals', 'uvs'] as const) for (const value of projection[key]) output[key].push(value);
          const center = triangle.reduce((sum, v) => sum + (v.uv[0] - decal.centerUv[0]) ** 2 + (v.uv[1] - decal.centerUv[1]) ** 2, 0);
          if (center < nearest) {
            const [a, b, c] = triangle, du1 = b.uv[0] - a.uv[0], dv1 = b.uv[1] - a.uv[1], du2 = c.uv[0] - a.uv[0], dv2 = c.uv[1] - a.uv[1];
            const determinant = du1 * dv2 - du2 * dv1;
            if (Math.abs(determinant) > 1e-12) {
              const du = points[1].clone().sub(points[0]).multiplyScalar(dv2).sub(points[2].clone().sub(points[0]).multiplyScalar(dv1)).divideScalar(determinant);
              const dv = points[2].clone().sub(points[0]).multiplyScalar(du1).sub(points[1].clone().sub(points[0]).multiplyScalar(du2)).divideScalar(determinant);
              const angle = decal.rotationDeg * Math.PI / 180;
              const width = du.clone().multiplyScalar(Math.cos(angle)).addScaledVector(dv, Math.sin(angle)).length() * decal.sizeUv[0];
              const height = du.clone().multiplyScalar(-Math.sin(angle)).addScaledVector(dv, Math.cos(angle)).length() * decal.sizeUv[1];
              if (width > 0 && height > 0) { aspect = height / width; nearest = center; }
            }
          }
        }
        if (!output.positions.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(output.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(output.normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(output.uvs, 2));
        geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
        patches.push({ mesh, geometry });
      }
      if (!patches.length) continue;
      const artwork = document.createElement('canvas');
      artwork.width = 1024; artwork.height = Math.max(128, Math.min(2048, Math.round(1024 * aspect)));
      const context = artwork.getContext('2d');
      if (!context) { patches.forEach(patch => patch.geometry.dispose()); throw new Error('Canvas text rendering is unavailable.'); }
      context.fillStyle = '#faf9f4'; context.fillRect(0, 0, artwork.width, artwork.height);
      context.fillStyle = '#344036'; context.textAlign = 'center'; context.textBaseline = 'middle';
      const draw = (text: string, y: number, fraction: number) => {
        let size = artwork.height * fraction;
        context.font = `500 ${size}px "Studio Sans", Arial, sans-serif`;
        const width = context.measureText(text).width;
        if (width > artwork.width * .84) { size *= artwork.width * .84 / width; context.font = `500 ${size}px "Studio Sans", Arial, sans-serif`; }
        context.fillText(text, artwork.width / 2, artwork.height * y);
      };
      draw(decal.text, .37, .24); draw(decal.subtitle, .73, .065);
      const texture = new THREE.CanvasTexture(artwork); texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: .53, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide });
      for (const patch of patches) {
        const artworkMesh = new THREE.Mesh(patch.geometry, material);
        artworkMesh.name = `Decal ${decal.id}`; artworkMesh.userData.gessoArtwork = true;
        artworkMesh.castShadow = decal.heightM > 0; artworkMesh.receiveShadow = true;
        patch.mesh.add(artworkMesh);
      }
    }
  }

  private async loadMeshProps(source: any, version: number, signal: AbortSignal): Promise<void> {
    for (const specification of source.environment.props || []) {
      if (specification.shape !== 'mesh') continue;
      const imported = await this.loadVerifiedGlb(specification.asset, signal);
      if (version !== this.loadVersion || this.disposed) { this.disposeObject(imported); return; }
      try {
        this.prepareImportedMesh(imported);
        const dimensions = specification.asset.sourceDimensionsM;
        if (!Array.isArray(dimensions) || dimensions.length !== 3 || dimensions.some(value => !Number.isFinite(value) || value <= 0)) {
          throw new Error('Imported props must declare their original dimensions in meters.');
        }
        imported.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(imported, true);
        const measured = bounds.getSize(new THREE.Vector3()).toArray();
        if (measured.some((value, axis) => Math.abs(value - dimensions[axis]) > Math.max(.00001, dimensions[axis] * .001))) {
          throw new Error('Imported prop dimensions do not match its verified GLB geometry.');
        }
        if (specification.materialOverride === true) this.overrideMaterial(imported, specification.material);
        const prop = new THREE.Group(); prop.name = specification.id;
        prop.add(imported);
        prop.position.fromArray(specification.translationM);
        prop.quaternion.fromArray(specification.rotationXyzw);
        prop.scale.fromArray(specification.sizeM.map((value: number, axis: number) => value / dimensions[axis]));
        // Normalization happened at import; keep every source node transform and UV.
        this.addEnvironmentObject(prop);
      } catch (error) { this.disposeObject(imported); throw error; }
    }
  }

  private prefilterEnvironment(texture: THREE.DataTexture): THREE.WebGLRenderTarget {
    const generator = new THREE.PMREMGenerator(this.renderer);
    try { return generator.fromEquirectangular(texture); }
    finally { generator.dispose(); }
  }

  private async loadHdri(source: any, version: number, signal: AbortSignal): Promise<void> {
    const hdri = source.lighting?.hdri;
    if (!hdri) return;
    const asset = hdri.asset;
    if (asset?.format !== 'hdr' || !/^[a-f0-9]{64}$/.test(asset?.sha256 || '') || asset.path !== `assets/${asset.sha256}.hdr`) {
      throw new Error('Environment lighting must declare a safe, content-addressed HDR image.');
    }
    const response = await fetch(this.assetUrl(asset), { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not load environment lighting (${response.status}).`);
    const limit = 32 * 1024 * 1024, declared = response.headers.get('Content-Length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('Environment lighting exceeds the 32 MiB limit.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 32 || bytes.byteLength > limit) throw new Error('Environment lighting is empty, truncated, or exceeds 32 MiB.');
    const header = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65536)));
    const dimensions = header.match(/(?:^|\n)-Y (\d+) \+X (\d+)(?:\r?\n)/);
    if (!/^#\?(RADIANCE|RGBE)\r?\n/.test(header) || !header.includes('FORMAT=32-bit_rle_rgbe') || !dimensions) {
      throw new Error('Environment lighting must be a standard Radiance RGBE image.');
    }
    const width = Number(dimensions[2]), height = Number(dimensions[1]);
    if (!width || !height || width > 4096 || height > 2048) throw new Error('Environment lighting must be at most 4096 × 2048 pixels.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== asset.sha256) throw new Error('Environment lighting SHA-256 does not match its immutable scene revision.');
    if (signal.aborted || version !== this.loadVersion || this.disposed) return;
    const parsed = new HDRLoader().parse(bytes);
    if (parsed.width !== width || parsed.height !== height) throw new Error('Environment lighting dimensions differ from its header.');
    const texture = new THREE.DataTexture(parsed.data, width, height, THREE.RGBAFormat, parsed.type);
    texture.colorSpace = THREE.LinearSRGBColorSpace; texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false; texture.flipY = true; texture.needsUpdate = true;
    try {
      const environment = this.prefilterEnvironment(texture);
      this.environmentMap?.dispose(); this.environmentMap = environment;
      this.scene.environment = environment.texture;
      this.scene.environmentIntensity = hdri.intensity;
      this.scene.environmentRotation.set(0, hdri.rotationDeg * Math.PI / 180, 0);
    } finally { texture.dispose(); }
  }

  private makeStudio(source: any): void {
    const plinth = source.environment.plinth;
    const material = plinth.material ? this.surface(plinth.material) : new THREE.MeshStandardMaterial({ color: this.color([0.56, 0.54, 0.49]), roughness: 0.58 });
    const ledge = new THREE.Mesh(this.geometry('box', plinth.sizeM, Math.min(0.004, ...plinth.sizeM.map((value: number) => value / 2))), material);
    ledge.name = 'Explicit contact plinth';
    ledge.position.fromArray(plinth.translationM);
    // The contact coordinates still place the product when its support is hidden.
    ledge.visible = plinth.visible !== false;
    ledge.castShadow = true;
    ledge.receiveShadow = true;
    this.addEnvironmentObject(ledge);
    for (const specification of source.environment.props || []) {
      if (specification.shape === 'mesh') continue; // Verified GLBs load before the scene is published.
      const prop = new THREE.Mesh(this.geometry(specification.shape, specification.sizeM, specification.bevelM), this.surface(specification.material));
      prop.name = specification.id;
      prop.position.fromArray(specification.translationM);
      prop.quaternion.fromArray(specification.rotationXyzw);
      prop.castShadow = true;
      prop.receiveShadow = true;
      this.addEnvironmentObject(prop);
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
      this.addEnvironmentObject(floor);
    }
    if (this.options.studioMode && !this.options.capture) {
      // A transparent receiver gives a white field with real contact shadows,
      // without a lit gray floor or a visible edge. Its support height stays
      // fixed while parts animate or the user isolates a subtree.
      const span = Math.max(...source.product.dimensionsM) * 100;
      const shadowMaterial = new THREE.ShadowMaterial({ color: 0x000000, opacity: .1, depthWrite: false });
      // Keep only nearby contact cues in this inspection view. Long shadows
      // from the live rig's directional approximation fade into the white.
      const contactCenter = new THREE.Vector2(source.placement.translationM[0], source.placement.translationM[2]);
      const contactRadius = Math.max(source.product.dimensionsM[0], source.product.dimensionsM[2]) * .9;
      shadowMaterial.onBeforeCompile = shader => {
        shader.uniforms.contactCenter = { value: contactCenter };
        shader.uniforms.contactRadius = { value: contactRadius };
        shader.vertexShader = 'varying vec2 contactPosition;\n' + shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\ncontactPosition = (modelMatrix * vec4(position, 1.0)).xz;');
        shader.fragmentShader = 'varying vec2 contactPosition;\nuniform vec2 contactCenter;\nuniform float contactRadius;\n' + shader.fragmentShader.replace('#include <tonemapping_fragment>',
          'gl_FragColor.a *= 1.0 - smoothstep(contactRadius, contactRadius * 3.0, distance(contactPosition, contactCenter));\n#include <tonemapping_fragment>');
      };
      shadowMaterial.customProgramCacheKey = () => 'product-contact-shadow-v1';
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(span, span), shadowMaterial);
      ground.name = 'Product contact shadow';
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(plinth.translationM[0], plinth.translationM[1] + plinth.sizeM[1] / 2 - .0001, plinth.translationM[2]);
      ground.receiveShadow = true;
      ground.visible = false;
      this.productGround = ground;
      this.content.add(ground);
    }
    if (source.lighting) {
      if (!areaLightUniformsReady) { RectAreaLightUniformsLib.init(); areaLightUniformsReady = true; }
      const lighting = source.lighting;
      // An optional ambient colour tints the sky half of the hemisphere; the
      // world colour remains the default, matching the Cycles world background.
      const ambient = new THREE.HemisphereLight(this.color(lighting.ambientColor ?? source.environment.worldColor), 0x454a43, lighting.ambientStrength * (1.2 / .45));
      this.content.add(ambient);
      const size = Math.max(...source.product.dimensionsM);
      for (const specification of lighting.lights) {
        if (!specification.enabled || specification.powerW === 0) continue;
        if (specification.type === 'spot') {
          // Cycles specifies a spot's watts like a point light's: the cone masks
          // the emission, it does not concentrate it. Three's SpotLight.power uses
          // the same convention (candela = lumens / 4π), so treating the saved
          // watts as lumens keeps the spot on the scale of the area lights below,
          // whose watts become radiance the same way Cycles reads them.
          const aim = new THREE.Vector3().fromArray(specification.targetM);
          const distance = Math.max(.001, new THREE.Vector3().fromArray(specification.positionM).distanceTo(aim));
          const light = new THREE.SpotLight(this.color(specification.color), specification.powerW / (4 * Math.PI), 0,
            THREE.MathUtils.degToRad((specification.coneDeg ?? 40) / 2), specification.blend ?? .3, 2);
          light.name = 'Studio / ' + specification.name;
          light.position.fromArray(specification.positionM);
          light.target.position.copy(aim);
          light.castShadow = true;
          light.shadow.mapSize.set(2048, 2048);
          light.shadow.bias = -.0002;
          // Curved product surfaces: offset by a fraction of the product size so
          // the hard shadow does not self-shadow into acne.
          light.shadow.normalBias = size * .004;
          light.shadow.camera.near = Math.max(.001, distance * .1);
          light.shadow.camera.far = distance * 3 + size * 10;
          this.content.add(light, light.target);
          this.rigLights().set(specification.id, {light, target: light.target, shadow: null});
          continue;
        }
        // WebGL uses a rectangular area emitter; Cycles exports the declared
        // disk with exact watts and diameter. Equal area keeps size meaningful.
        const side = specification.diameterM * Math.sqrt(Math.PI) / 2;
        const luminance = specification.powerW / (Math.PI * side * side);
        const light = new THREE.RectAreaLight(this.color(specification.color), luminance, side, side);
        light.name = 'Studio / ' + specification.name;
        light.position.fromArray(specification.positionM);
        light.lookAt(new THREE.Vector3().fromArray(specification.targetM));
        this.content.add(light);
        // RectAreaLight has no WebGL shadow map. A weak, coincident directional
        // contribution provides contact cues, not a second export light.
        const distanceSquared = light.position.distanceToSquared(new THREE.Vector3().fromArray(specification.targetM));
        const shadow = new THREE.DirectionalLight(this.color(specification.color), specification.powerW / Math.max(.001, distanceSquared) * .035);
        shadow.position.copy(light.position);
        shadow.target.position.fromArray(specification.targetM);
        shadow.castShadow = true;
        shadow.shadow.mapSize.set(1024, 1024);
        shadow.shadow.camera.left = -size * 3;
        shadow.shadow.camera.right = size * 3;
        shadow.shadow.camera.top = size * 3;
        shadow.shadow.camera.bottom = -size * 2;
        shadow.shadow.camera.near = .001;
        shadow.shadow.camera.far = Math.max(size * 15, Math.sqrt(distanceSquared) * 2);
        shadow.shadow.bias = -.00005;
        // Offset by two shadow texels so tessellated curved surfaces do not
        // self-shadow; this is a preview sampling correction in world meters.
        shadow.shadow.normalBias = Math.max(
          (shadow.shadow.camera.right - shadow.shadow.camera.left) / shadow.shadow.mapSize.x,
          (shadow.shadow.camera.top - shadow.shadow.camera.bottom) / shadow.shadow.mapSize.y) * 2;
        this.content.add(shadow, shadow.target);
        this.rigLights().set(specification.id, {light, target: null, shadow});
      }
      return;
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
      // Keep the sampling offset proportional to shadow resolution and scene size.
      light.shadow.normalBias = Math.max(
        (light.shadow.camera.right - light.shadow.camera.left) / light.shadow.mapSize.x,
        (light.shadow.camera.top - light.shadow.camera.bottom) / light.shadow.mapSize.y) * 2;
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

  /** A draft swaps only GPU material instances. Authored materials, geometry,
   * poses and the inspection camera remain intact until the user saves. */
  async setMaterialPreview(preview: MaterialPreview | null): Promise<void> {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    const state = this.materialPreviewState ??= {
      descriptor: null, revision: 0, abort: null, applied: null, pending: null, running: null,
    };
    state.abort?.abort();
    state.pending?.resolve(); // A superseded request is not a user-visible failure.
    state.revision++;
    state.descriptor = preview ? structuredClone(preview) : null;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    state.pending = { promise, resolve, reject };
    if (!preview) {
      this.restoreFocusMaterials();
      this.restoreMaterialPreview();
      this.applyPartPreview();
      state.pending.resolve(); state.pending = null;
      this.invalidate();
    } else if (this.loadFailed) {
      state.pending.reject(new Error('Load the product before previewing a material.')); state.pending = null;
    } else if (!this.loading) {
      void this.runMaterialPreview();
    }
    // While load() is rebuilding the product, the pending request is applied
    // there before its first sampled frame, and resolves only after that swap.
    return promise;
  }

  private restoreMaterialPreview(): void {
    const state = this.materialPreviewState;
    if (!state?.applied) return;
    for (const [mesh, original] of state.applied.originals) {
      mesh.material = original.material;
      mesh.castShadow = original.castShadow;
    }
    disposeSurfaceMaterial(state.applied.material);
    state.applied = null;
  }

  private runMaterialPreview(): Promise<void> {
    const state = this.materialPreviewState;
    if (!state?.descriptor || this.disposed || this.options.capture) return Promise.resolve();
    const revision = state.revision, loadVersion = this.loadVersion;
    if (state.running?.revision === revision && state.running.loadVersion === loadVersion) return state.running.promise;
    const descriptor = state.descriptor;
    const abort = new AbortController(); state.abort = abort;
    const material = createSurfaceMaterial(descriptor.material);
    let published = false;
    const current = () => !this.disposed && !abort.signal.aborted && revision === state.revision && loadVersion === this.loadVersion;
    const promise = Promise.resolve().then(async () => {
      try {
        if (Object.keys(descriptor.material.textures || {}).length) {
          await loadMaterialTextures(material, descriptor.material, asset => this.assetUrl(asset), { signal: abort.signal });
        }
        if (!current()) return;
        const meshes = new Set<THREE.Mesh>();
        for (const id of new Set(descriptor.componentIds)) {
          const component = this.components.get(id);
          const root = component || this.parts.get(id);
          if (!root || component && root.userData.gessoPrimitiveShape === 'mesh' && !root.userData.gessoMaterialOverride) continue;
          const visit = (object: THREE.Object3D) => {
            if (object.userData.gessoArtwork) return;
            const boundPreset = object.userData.gessoMaterialBindingPresetId;
            if (object !== root && boundPreset && boundPreset !== descriptor.presetId) return;
            if (object instanceof THREE.Mesh) meshes.add(object);
            for (const child of object.children) visit(child);
          };
          visit(root);
        }
        if (!meshes.size) throw new Error('Select an editable product part to preview this material.');
        // Focus/probe clones wrap the material draft, never become its source.
        // Both replacement and cancellation unwind these layers in reverse.
        this.restoreFocusMaterials();
        this.restoreMaterialPreview();
        const originals = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }>();
        for (const mesh of meshes) {
          originals.set(mesh, { material: mesh.material, castShadow: mesh.castShadow });
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => material) : material;
        }
        state.applied = { material, originals }; published = true;
        this.applyPartPreview();
        this.invalidate();
        state.pending?.resolve(); state.pending = null;
      } catch (error) {
        if (current()) {
          if (state.pending) { state.pending.reject(error); state.pending = null; }
        }
      } finally {
        if (!published) disposeSurfaceMaterial(material);
        if (state.abort === abort) state.abort = null;
        if (state.running?.revision === revision && state.running.loadVersion === loadVersion) state.running = null;
      }
    });
    state.running = { revision, loadVersion, promise };
    return promise;
  }

  private async restoreMaterialPreviewAfterLoad(version: number): Promise<void> {
    // New pointer/slider input can supersede a map decode during the reload.
    // Follow the newest request before allowing the sampled frame to publish.
    while (this.materialPreviewState?.descriptor && version === this.loadVersion && !this.disposed) {
      const revision = this.materialPreviewState.revision;
      await this.runMaterialPreview();
      if (revision === this.materialPreviewState.revision) break;
    }
  }

  private productKey(source: any): string {
    return JSON.stringify((source.product?.components || []).map((component: any) => [
      component.id, component.shape, component.asset?.sha256 || null,
    ]).sort((a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]))));
  }

  async load(source: any, assetUrl?: string): Promise<void> {
    if (Number.isFinite(source.render?.width) && Number.isFinite(source.render?.height) && source.render.width > 0 && source.render.height > 0) {
      this.filmOutputAspect = source.render.width / source.render.height;
      this.applyFilmProjection(this.camera, this.pendingSize);
    }
    if (this.disposed) throw new Error('Viewport has been disposed.');
    this.assetAbort?.abort();
    const assetAbort = new AbortController();
    this.assetAbort = assetAbort;
    const version = ++this.loadVersion;
    this.unpresentedLoadVersion = version;
    this.frameRequest++;
    this.loading = true;
    this.options.onLoading?.(true);
    this.loadFailed = false;
    this.awaitingSample = !this.options.capture;
    this.cancelRender();
    const productKey = this.productKey(source);
    // Material/label/placement revisions rebuild GPU resources but keep the
    // user's inspection camera. Different geometry assets or component sets
    // establish a new product and return to its authored shot.
    this.clearContent(!!this.options.studioMode && productKey === this.loadedProductKey);
    this.loadedProductKey = productKey;
    const environment = source.environment;
    const capture = !!this.options.capture;
    this.environmentBackground = capture ? null : this.color(environment.worldColor);
    this.scene.background = this.environmentBackground;
    this.applyProductPreview();
    try {
      if (this.imageRenderer || source.shots?.some((shot: any) => shot.kind === 'image')) {
        this.imageRenderer ??= new FilmImageRenderer();
        await this.imageRenderer.prepare(source.shots ?? [], assetAbort.signal);
        if (version !== this.loadVersion || this.disposed) return;
      }
      if (capture && environment.kind !== 'splat') throw new Error('Capture requires a Gaussian splat world.');
      if (!capture) {
        // The packaged font keeps label artwork independent of host fontconfig
        // and must finish loading before measuring/drawing its canvas texture.
        await document.fonts.load('500 32px "Studio Sans"');
        if (version !== this.loadVersion || this.disposed) return;
        await this.makeProduct(source, version, assetAbort.signal);
        if (version !== this.loadVersion || this.disposed) return;
        this.makeStudio(source);
        await this.loadMeshProps(source, version, assetAbort.signal);
        if (version !== this.loadVersion || this.disposed) return;
        await this.loadSurfaceTextures(assetAbort.signal);
        if (version !== this.loadVersion || this.disposed) return;
        await this.loadHdri(source, version, assetAbort.signal);
        if (version !== this.loadVersion || this.disposed) return;
      }
      if (environment.kind === 'mesh') {
        const imported = await this.loadVerifiedGlb(environment.asset, assetAbort.signal, assetUrl);
        if (version !== this.loadVersion || this.disposed) { this.disposeObject(imported); return; }
        this.prepareImportedMesh(imported);
        const root = new THREE.Group();
        this.alignWorld(root, environment.asset);
        root.add(imported);
        this.addEnvironmentObject(root);
        this.worldRoot = root;
        this.worldLoadVersion = version;
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
        this.addEnvironmentObject(root);
        await splat.initialized;
        if (version !== this.loadVersion || this.disposed) return;
      }
      if (version !== this.loadVersion || this.disposed) return;
      await this.restoreMaterialPreviewAfterLoad(version);
      if (version !== this.loadVersion || this.disposed) return;
      this.loading = false;
      this.applyProductPreview();
      this.updateControlsEnabled();
      this.resize();
      this.setSelection(this.selectedId);
      // The editor adapter applies its sampled poses/camera next. In particular,
      // never show an unsampled assembly frame while a replacement scene loads.
      if (capture) await this.render(true);
      if (version === this.loadVersion && !this.disposed) {
        this.worldReady = !!this.worldRoot;
        this.options.onReady?.();
      }
    } catch (error: any) {
      if (version !== this.loadVersion || this.disposed) return;
      this.loading = false;
      this.loadFailed = true;
      this.options.onLoading?.(false);
      this.materialPreviewState?.pending?.reject(error);
      if (this.materialPreviewState) this.materialPreviewState.pending = null;
      this.worldReady = false;
      this.updateControlsEnabled();
      this.options.onError?.(error?.message || String(error));
      throw error;
    }
  }

  private assetUrl(asset: any): string {
    return sceneAssetUrl(asset);
  }

  async frame(sample: any): Promise<void> {
    if (this.disposed) throw new Error('Viewport has been disposed.');
    const request = ++this.frameRequest;
    const version = this.loadVersion;
    // Explicit callers can await the exact submitted frame. Serializing Spark
    // updates prevents a later camera from overtaking a requested capture.
    const task = this.frameQueue.catch(() => {}).then(async () => {
      if (this.disposed || version !== this.loadVersion || (!this.options.capture && request !== this.frameRequest)) return;
      // An invalidation-driven Gaussian draw may still be sorting. Finish its
      // frozen camera/pose pair before changing the scene to a newer sample.
      if (!this.options.capture && this.liveRender) await this.liveRender;
      if (this.disposed || version !== this.loadVersion || (!this.options.capture && request !== this.frameRequest)) return;
      if (this.loading || this.loadFailed) { this.dirty = true; return; }
      const previousKind = this.filmClip?.kind; this.filmClip = sample.clip ?? {kind: 'scene'};
      if (previousKind !== this.filmClip.kind) this.updateControlsEnabled();
      for (const [id, pose] of Object.entries(sample.components || {}) as [string, any][]) {
        const component = this.components.get(id);
        if (!component) continue;
        component.position.fromArray(pose.translationM);
        component.quaternion.fromArray(pose.rotationXyzw);
        component.scale.setScalar(pose.scale ?? 1);
      }
      this.applyLightPoses(sample.lights ?? []);
      const values = sample.camera;
      this.sampledOptics = sampledDepthOfField(values);
      const inspection = this.inspectingCamera ? {
        position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov,
      } : null;
      this.camera.position.fromArray(values.positionM);
      this.camera.lookAt(new THREE.Vector3().fromArray(values.targetM));
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(18 / values.focalLengthMm));
      this.sampledCamera = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(),
        fov: this.camera.fov, target: new THREE.Vector3().fromArray(values.targetM) };
      if (inspection) {
        this.camera.position.copy(inspection.position); this.camera.quaternion.copy(inspection.quaternion); this.camera.fov = inspection.fov;
      } else if (this.controls) {
        this.controls.target.copy(this.sampledCamera.target);
        this.controls.update();
      }
      this.camera.updateProjectionMatrix();
      this.updateUvProbeScale();
      if (this.framedSelection) this.fitSelection();
      this.selection?.update();
      const firstSample = this.awaitingSample;
      this.awaitingSample = false;
      this.sampledLoadVersion = version;
      if (firstSample) this.updateControlsEnabled();
      if (!this.loading && (this.options.capture || (!document.hidden && this.visible))) await this.render(!!this.spark);
      else this.dirty = true;
    });
    const result = task.catch(error => {
      if (!this.disposed && version === this.loadVersion) this.options.onLoading?.(false);
      throw error;
    });
    this.frameQueue = result;
    return result;
  }

  /** Sampled light poses exist only for scenes that animate a light. A spot
   * moves with its aim target; an area light re-aims with its shadow helper. */
  private applyLightPoses(poses: any[]): void {
    for (const pose of poses) {
      const entry = this.studioLights?.get(pose.id);
      if (!entry) continue;
      const aim = new THREE.Vector3().fromArray(pose.targetM);
      entry.light.position.fromArray(pose.positionM);
      if (entry.target) entry.target.position.copy(aim); else entry.light.lookAt(aim);
      if (entry.shadow) { entry.shadow.position.copy(entry.light.position); entry.shadow.target.position.copy(aim); }
    }
  }

  private render(settle: boolean): Promise<void> {
    if (this.options.capture) {
      // Export callers await every exact frame; never coalesce or drop them.
      const version = this.loadVersion;
      const task = this.renderQueue.catch(() => {}).then(() => this.draw(settle, version));
      this.renderQueue = task;
      return task;
    }
    this.dirty = true;
    this.cancelRender();
    if (this.liveRender) return this.liveRender;
    // One in-flight render consumes all pending invalidations. If layout or
    // input changes during an asynchronous Gaussian sort, draw the latest next
    // instead of building a queue of obsolete resize frames.
    const task = Promise.resolve().then(async () => {
      while (this.dirty && this.canDraw()) {
        this.dirty = false;
        await this.draw(false, this.loadVersion);
      }
    });
    this.liveRender = task;
    void task.then(() => {
      if (this.liveRender === task) this.liveRender = null;
      this.scheduleRender();
    }, () => {
      if (this.liveRender === task) this.liveRender = null;
      // Keep the previous image on failure. A subsequent user action may retry.
    });
    return task;
  }

  private async draw(settle: boolean, version: number): Promise<void> {
    if (!this.canDraw() || version !== this.loadVersion || !this.pendingSize) return;
    const size = this.pendingSize;
    const presentationVersion = this.presentationVersion ?? 0;
    if (this.filmContent && !this.productPreview && this.filmClip && this.filmClip.kind !== 'scene') {
      this.imageRenderer ??= new FilmImageRenderer();
      if (this.renderedSize?.width !== size.width || this.renderedSize.height !== size.height) {
        this.renderer.setSize(size.width, size.height, false); this.renderedSize = size;
      }
      const gate = this.filmGuides ? filmGateRect(size.width, size.height, this.filmOutputAspect) : {x: 0, y: 0, ...size};
      this.imageRenderer.draw(this.renderer, this.filmClip, size, gate);
      this.presentedFilm = null; this.options.onFilmGuide?.(null);
      if (settle) this.renderer.getContext().finish();
      this.reportPresented(version); return;
    }
    // Orbit/resize may change the live camera while Spark awaits its worker.
    // Sort and draw the same camera, then consume newer input on the next frame.
    const camera = this.options.capture ? this.camera : this.camera.clone();
    camera.aspect = size.width / size.height;
    this.applyFilmProjection(camera, size);
    // Match guides to this frozen frame even if a later pose arrives during a Gaussian sort.
    const filmGuide = this.filmGuides && !this.options.capture && this.sampledCamera
      ? projectFilmGuide(camera, size.width, size.height, this.filmOutputAspect, this.sampledCamera.target,
        this.sampledCamera.position, 18 / Math.tan(THREE.MathUtils.degToRad(this.sampledCamera.fov) / 2), this.inspectingCamera)
      : null;
    const spark = this.spark;
    const optics = this.sampledOptics ? {...this.sampledOptics, enabled: this.sampledOptics.enabled && !this.productPreview} : null;
    const focalLengthMm = 18 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    if (spark) {
      spark.focalDistance = optics?.enabled ? optics.focusDistanceM : 0;
      spark.apertureAngle = optics?.enabled ? sparkApertureAngle(focalLengthMm, optics.focusDistanceM, optics.fStop) : 0;
    }
    this.content.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    if (spark && spark.visible !== false) {
      const ratio = this.renderer.getPixelRatio();
      spark.renderSize.set(Math.floor(size.width * ratio), Math.floor(size.height * ratio));
      // These are the next buffer dimensions. Reading the current drawing
      // buffer here would sort for the old size, or force us to clear it early.
      try {
        await spark.update({ scene: this.scene, camera });
      } catch (error) {
        // Replacing a world disposes its worker. A late rejection belongs to
        // that superseded load, not the replacement waiting to be presented.
        if (this.disposed || version !== this.loadVersion) return;
        throw error;
      }
      if (version !== this.loadVersion) return;
      if (!this.canDraw()) { this.dirty = true; return; }
      if (spark.sorting || spark.sortDirty || spark.sortTimeoutId !== undefined) {
        throw new Error('The Gaussian sort did not settle for the requested camera.');
      }
    }
    if (version !== this.loadVersion) return;
    if (!this.canDraw()) { this.dirty = true; return; }
    // A workspace switch changes presentation, not the sampled scene. Never
    // finish an obsolete Film/optics frame into a newly selected Product view.
    if (presentationVersion !== (this.presentationVersion ?? 0)) { this.dirty = true; return; }
    // Atomic presentation: setSize clears WebGL. Nothing asynchronous may run
    // between that clear and the replacement render in this same browser task.
    if (this.renderedSize?.width !== size.width || this.renderedSize.height !== size.height) {
      this.renderer.setSize(size.width, size.height, false);
      this.renderedSize = size;
    }
    if (optics?.enabled && !this.options.capture) {
      this.depthOfFieldPreview ??= new DepthOfFieldPreview();
      this.depthOfFieldPreview.render(this.renderer, this.scene, camera, size.width, size.height, optics, focalLengthMm, !!spark && spark.visible !== false);
    } else {
      this.depthOfFieldPreview?.dispose(); this.depthOfFieldPreview = null;
      // Capture contains Gaussian-world plates only; Spark applies aperture blur from its actual splat depths.
      this.renderer.render(this.scene, camera);
    }
    if (this.filmGuides && filmGuide) {
      this.presentedFilm = {camera: camera.clone(), target: new THREE.Vector3().fromArray(filmGuide.targetM)};
      this.options.onFilmGuide?.(filmGuide);
    }
    if (settle) this.renderer.getContext().finish();
    this.reportPresented(version);
  }

  private reportPresented(version: number) {
    // Asset readiness does not imply a displayed image.
    if (this.unpresentedLoadVersion === version && this.sampledLoadVersion === version) {
      this.unpresentedLoadVersion = null;
      this.options.onLoading?.(false);
      this.options.onPresented?.();
    }
  }

  setSelection(id: string | null): void {
    this.selectedId = id;
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
      this.selection = null;
    }
    const component = id ? this.parts.get(id) || this.components.get(id) : undefined;
    if (component && !this.options.capture && !this.options.studioMode) {
      component.updateWorldMatrix(true, true);
      this.selection = new THREE.BoxHelper(component, 0xd8e7ad);
      this.scene.add(this.selection);
    }
    this.applyPartPreview();
    if (this.framedSelection) this.fitSelection();
    this.invalidate();
  }

  setPartFocus(enabled: boolean): void {
    this.partFocus = !!enabled && !!this.options.studioMode && !this.options.capture;
    this.applyPartPreview();
    this.invalidate();
  }

  setMaterialHover(hover: MaterialHover | null): void {
    this.materialHover = hover ? {presetId: hover.presetId, partIds: [...new Set(hover.partIds)]} : null;
    this.applyPartPreview();
    this.invalidate();
  }

  /** Resolve actual source assignments, stopping at a different section finish.
   * Explicit same-preset descendant roots can re-enter an overridden subtree. */
  private materialHoverMeshes(): Set<THREE.Mesh> {
    const meshes = new Set<THREE.Mesh>();
    const hover = this.materialHover;
    if (!hover) return meshes;
    const visit = (object: THREE.Object3D) => {
      const binding = object.userData.gessoMaterialBindingPresetId;
      if (binding && binding !== hover.presetId) return;
      if (object instanceof THREE.Mesh) meshes.add(object);
      for (const child of object.children) visit(child);
    };
    for (const id of hover.partIds) {
      const root = this.parts.get(id) || this.components.get(id);
      if (root) visit(root);
    }
    return meshes;
  }

  setHiddenParts(ids: string[]): void {
    this.hiddenParts = new Set(ids);
    this.applyPartPreview();
    this.invalidate();
  }

  /** Semantic assembly membership is a preview overlay, never source reparenting. */
  setFocusParts(ids: string[]): void {
    this.focusPartIds = [...new Set(ids)];
    this.applyPartPreview();
    if (this.framedSelection) this.fitSelection();
    this.invalidate();
  }

  private focusedRoots(): THREE.Object3D[] {
    const roots = this.focusPartIds.map(id => this.parts.get(id)).filter((object): object is THREE.Object3D => !!object);
    if (roots.length) return roots;
    const selected = this.selectedId ? this.parts.get(this.selectedId) : undefined;
    return selected ? [selected] : [];
  }

  private restoreFocusMaterials(): void {
    for (const [mesh, original] of this.focusMaterials) {
      mesh.material = original.material;
      mesh.castShadow = original.castShadow;
    }
    this.focusMaterials.clear();
    // Clones share immutable textures with source materials. Dispose only the
    // temporary material instances here; textures belong to the loaded scene.
    this.previewMaterials.forEach(material => material.dispose());
    this.previewMaterials.clear();
  }

  private applyPartPreview(): void {
    this.restoreFocusMaterials();
    for (const [object, visible] of this.originalVisibility) object.visible = visible;
    if (!this.options.studioMode || this.options.capture) return;
    for (const id of this.hiddenParts) {
      const object = this.parts.get(id);
      if (object) object.visible = false;
    }
    const selectedRoots = this.focusedRoots();
    const probeRoot = this.uvProbePartId ? this.parts.get(this.uvProbePartId) : null;
    const materialMeshes = this.materialHoverMeshes();
    if ((!this.partFocus || !selectedRoots.length) && !probeRoot && !materialMeshes.size) return;
    const selectedMeshes = new Set<THREE.Object3D>(), probeMeshes = new Set<THREE.Object3D>();
    selectedRoots.forEach(root => root.traverse(object => selectedMeshes.add(object)));
    probeRoot?.traverse(object => probeMeshes.add(object));
    const clones = new Map<THREE.Material, Map<number, THREE.Material>>();
    const faded = (material: THREE.Material, opacity: number) => {
      let variants = clones.get(material);
      if (!variants) { variants = new Map(); clones.set(material, variants); }
      let preview = variants.get(opacity);
      if (!preview) {
        preview = material.clone(); preview.transparent = true;
        preview.opacity = material.opacity * opacity; preview.depthWrite = false;
        variants.set(opacity, preview); this.previewMaterials.add(preview);
      }
      return preview;
    };
    for (const component of this.components.values()) component.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const opacity = materialMeshes.size ? (materialMeshes.has(object) ? 1 : .18)
        : probeMeshes.has(object) ? .72 : this.partFocus && selectedRoots.length && !selectedMeshes.has(object) ? .18 : 1;
      if (opacity === 1) return;
      this.focusMaterials.set(object, { material: object.material, castShadow: object.castShadow });
      object.material = Array.isArray(object.material) ? object.material.map(material => faded(material, opacity)) : faded(object.material, opacity);
      object.castShadow = false;
    });
  }

  frameSelection(): void {
    if (!this.options.studioMode || this.options.capture || this.disposed || !this.focusedRoots().length) return;
    if (!this.sampledCamera) this.sampledCamera = {
      position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov,
      target: this.controls?.target.clone() || this.camera.position.clone().add(this.camera.getWorldDirection(new THREE.Vector3())),
    };
    this.inspectingCamera = true;
    this.framedSelection = true;
    this.framedWorldObjectId = null;
    this.fitSelection();
    this.invalidate();
  }

  /** Read the rendered target and camera; posedScene supplies sampled transform channels before mechanical motion. */
  createTransformGesture(target: TransformTarget, pointer: TransformPointer, posedScene?: any): TransformGesture | null {
    if (this.disposed || this.loading || this.loadFailed || this.awaitingSample || this.options.capture || !this.transformPlacement) return null;
    const component = target.kind === 'part' ? this.components.get(target.componentId) : null;
    if (target.kind === 'part' && !component) return null;
    const placementScale = posedScene ? posedScene.placement.scale ?? 1 : this.transformPlacement.scale;
    let placementPivot = this.transformPlacement.pivot;
    if (posedScene) {
      placementPivot = new THREE.Vector3().fromArray(posedScene.placement.translationM);
      const support = posedScene.environment?.plinth;
      if (support) placementPivot.add(new THREE.Vector3().fromArray(support.translationM)).add(new THREE.Vector3(0, support.sizeM[1] / 2, 0));
    }
    // Keep the part's actual rendered origin (including mechanical travel), but use
    // the authored XYZ orientation at this time to determine its Euler control axes.
    const posedComponent = target.kind === 'part' ? posedScene?.product.components.find((part: any) => part.id === target.componentId) : null;
    const pivot = component ? component.getWorldPosition(new THREE.Vector3()) : placementPivot;
    this.camera.updateMatrixWorld(true);
    return createTransformPointerGesture(this.camera, this.canvas.getBoundingClientRect(), pivot, pointer, {
      translationScale: component ? placementScale : 1,
      rotationXyzw: posedComponent?.assembly.rotationXyzw ?? component?.userData.gessoAssemblyRotation,
    });
  }

  /** Keep the current view fixed while a transform changes the selected bounds. */
  freezeSelectionFraming(): void {
    this.framedSelection = false;
    this.framedWorldObjectId = null;
  }

  /** Frame the real prop instance while keeping the sampled shot available to reset. */
  frameWorldObject(id: string): void {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    if (!this.sampledCamera) this.sampledCamera = {
      position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov,
      target: this.controls?.target.clone() || this.camera.position.clone().add(this.camera.getWorldDirection(new THREE.Vector3())),
    };
    this.inspectingCamera = true;
    this.framedSelection = true;
    // Keep the identifier through an in-flight import; load()/frame() refit once ready.
    this.framedWorldObjectId = id;
    this.fitSelection();
    this.invalidate();
  }

  private fitSelection(): void {
    const bounds = new THREE.Box3();
    const roots = this.framedWorldObjectId
      ? [...this.environmentObjects.keys()].filter(object => object.name === this.framedWorldObjectId)
      : this.focusedRoots();
    for (const selected of roots) {
      if (!this.objectVisible(selected)) continue;
      selected.updateWorldMatrix(true, true);
      selected.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox) bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      });
    }
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) return;
    const vertical = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    const distance = sphere.radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.18;
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    this.camera.position.copy(sphere.center).addScaledVector(direction, -distance);
    this.camera.lookAt(sphere.center);
    if (this.controls) {
      this.controls.target.copy(sphere.center);
      this.controls.update();
    }
    this.camera.updateMatrixWorld(true);
  }

  resetFraming(): void {
    if (!this.options.studioMode || this.options.capture || this.disposed) return;
    this.framedSelection = false;
    this.framedWorldObjectId = null;
    this.inspectingCamera = false;
    if (this.sampledCamera) {
      this.camera.position.copy(this.sampledCamera.position);
      this.camera.quaternion.copy(this.sampledCamera.quaternion);
      this.camera.fov = this.sampledCamera.fov;
      this.camera.updateProjectionMatrix();
      if (this.controls) {
        this.controls.target.copy(this.sampledCamera.target);
        this.controls.update();
        // OrbitControls rebuilds position through spherical coordinates. Keep
        // the exact sampled camera after synchronizing its gesture state.
        this.camera.position.copy(this.sampledCamera.position);
        this.camera.quaternion.copy(this.sampledCamera.quaternion);
      }
    }
    this.invalidate();
  }

  private disposeObject(root: THREE.Object3D): void {
    disposeSceneObject(root);
  }

  private clearContent(preserveInspection = false): void {
    this.clearUvProbe();
    this.uvProbeSources = [];
    this.restoreFocusMaterials();
    this.materialPreviewState?.abort?.abort();
    if (this.materialPreviewState) this.materialPreviewState.running = null;
    this.restoreMaterialPreview();
    this.parts.clear();
    this.originalVisibility.clear();
    this.transformPlacement = null;
    if (!preserveInspection) {
      this.framedSelection = false;
      this.framedWorldObjectId = null;
      this.inspectingCamera = false;
      this.sampledCamera = null;
      this.loadedProductKey = null;
    }
    this.updateControlsEnabled();
    this.worldRoot = null;
    this.worldLoadVersion = -1;
    this.worldReady = false;
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
    this.environmentObjects.clear();
    this.environmentBackground = null;
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    this.scene.environmentRotation.set(0, 0, 0);
    this.environmentMap?.dispose(); this.environmentMap = null;
    this.productGround = null;
    this.studioLights?.clear();
  }

  clearScene(): void {
    if (this.disposed) return;
    this.materialPreviewState?.pending?.resolve();
    if (this.materialPreviewState) { this.materialPreviewState.pending = null; this.materialPreviewState.descriptor = null; }
    this.loadVersion++;
    this.unpresentedLoadVersion = null;
    this.materialHover = null;
    this.sampledLoadVersion = -1;
    this.frameRequest++;
    this.assetAbort?.abort();
    this.assetAbort = null;
    this.loading = false;
    this.options.onLoading?.(false);
    this.loadFailed = false;
    this.awaitingSample = false;
    this.cancelRender();
    this.clearContent();
    this.filmClip = {kind: 'scene'};
    this.imageRenderer?.dispose(); this.imageRenderer = null;
    this.scene.background = null;
    this.presentedFilm = null;
    this.sampledOptics = null;
    this.depthOfFieldPreview?.dispose(); this.depthOfFieldPreview = null;
    this.options.onFilmGuide?.(null);
    this.options.onParts?.([]);
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.onLoading?.(false);
    this.depthOfFieldPreview?.dispose(); this.depthOfFieldPreview = null;
    this.presentedFilm = null;
    this.options.onFilmGuide?.(null);
    this.materialPreviewState?.pending?.resolve();
    if (this.materialPreviewState) { this.materialPreviewState.pending = null; this.materialPreviewState.descriptor = null; }
    this.setWorldPickEnabled(false);
    this.loadVersion++;
    this.assetAbort?.abort();
    this.cancelRender();
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.disposeControls();
    this.clearContent();
    this.uvProbeMaterial?.map?.dispose();
    this.uvProbeMaterial?.dispose();
    this.uvProbeMaterial = null;
    this.imageRenderer?.dispose(); this.imageRenderer = null;
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Host-based adapter used by the editor and the isolated /capture route. */
export function createViewport(host: HTMLElement, options: Omit<ViewportOptions, 'onSelect'> & {
  onSelect?: (id: string | null) => void;
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
    if (options.studioMode) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      return;
    }
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
    setUvProbePart(partId: string | null) { viewport.setUvProbePart(partId); },
    setUvProbe(uv: [number, number] | null) { viewport.setUvProbe(uv); },
    getUvLayout(partId: string) { return viewport.getUvLayout(partId); },
    setSelected(id: string | null) { viewport.setSelection(id); },
    setPartFocus(enabled: boolean) { viewport.setPartFocus(enabled); },
    setProductPreview(enabled: boolean) { viewport.setProductPreview(enabled); },
    setMaterialPreview(preview: MaterialPreview | null) { return viewport.setMaterialPreview(preview); },
    setFocusParts(ids: string[]) { viewport.setFocusParts(ids); },
    setMaterialHover(hover: MaterialHover | null) { viewport.setMaterialHover(hover); },
    setHiddenParts(ids: string[]) { viewport.setHiddenParts(ids); },
    frameSelection() { viewport.frameSelection(); },
    freezeSelectionFraming() { viewport.freezeSelectionFraming(); },
    createTransformGesture(target: TransformTarget, pointer: TransformPointer, posedScene?: any) { return viewport.createTransformGesture(target, pointer, posedScene); },
    frameWorldObject(id: string) { viewport.frameWorldObject(id); },
    resetFraming() { viewport.resetFraming(); },
    setWorldPickEnabled(enabled: boolean) { viewport.setWorldPickEnabled(enabled); },
    setInspectionEnabled(enabled: boolean) { viewport.setInspectionEnabled(enabled); },
    setFilmGuides(enabled: boolean) { viewport.setFilmGuides(enabled); },
    setFilmContent(enabled: boolean) { viewport.setFilmContent(enabled); },
    createCameraTargetGesture(pointer: CameraTargetPointer) { return viewport.createCameraTargetGesture(pointer); },
    setInteractionSurface(element: HTMLElement | null) { viewport.setInteractionSurface(element); },
    clearScene() {
      version++;
      latestSample = null;
      captureFrames = [];
      viewport.clearScene();
    },
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
