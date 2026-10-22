import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {StudioViewport} from './viewport';
import {applyProductWorldFit, fitProductToWorld, type ProductWorldFit} from './productWorldFit';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function productScene(): any {
  const scene: any = structuredClone(fixture);
  delete scene.product.label; // Text artwork is tested separately from bounds.
  return scene;
}

/** Use the export sampler itself, so the follow-up fit cannot pass by updating
 * preview geometry without updating the saved scene's authored scale. */
function canonical(scene: any, frame = 51): any {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
    'import json,sys; from film.scene import evaluate,validate_scene; p=json.load(sys.stdin); print(json.dumps(evaluate(validate_scene(p["scene"]),p["frame"],include_placement=True)))'],
  {cwd: projectRoot, input: JSON.stringify({scene, frame}), encoding: 'utf8'}));
}

function viewport() {
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  Object.assign(view, {
    scene, content, camera: new THREE.PerspectiveCamera(40, 1.4, .001, 100),
    canvas: {style: {}, clientHeight: 800, clientWidth: 1120},
    options: {studioMode: true, capture: false, onParts: vi.fn()},
    parts: new Map(), components: new Map(), environmentObjects: new Map(),
    originalVisibility: new Map(), focusMaterials: new Map(), previewMaterials: new Set(),
    hiddenParts: new Set(), focusPartIds: [], partFocus: false, selectedId: null,
    selection: null, framedSelection: false, inspectingCamera: false, controls: null,
    sampledCamera: null, disposed: false, loading: false, loadFailed: false, awaitingSample: false,
    loadVersion: 1, frameRequest: 0, frameQueue: Promise.resolve(), liveRender: null,
    dirty: false, visible: false, deferredWorld: null,
  });
  view.invalidate = vi.fn(); view.render = vi.fn(async () => {});
  vi.stubGlobal('document', {hidden: true});
  const world = new THREE.Group(), imported = new THREE.Group();
  world.position.set(.06, .1, -.4); world.rotation.y = .3; world.scale.setScalar(1.2);
  imported.rotation.z = -.08; imported.scale.set(1.1, .9, 1.3);
  imported.add(new THREE.Mesh(new THREE.BoxGeometry(.8, .7, .2), new THREE.MeshBasicMaterial()));
  world.add(imported); content.add(world); view.worldFitRoot = world;
  return view;
}

function cameraFor(sample: any, aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(18 / sample.camera.focalLengthMm)), aspect, .001, 100);
  camera.position.fromArray(sample.camera.positionM); camera.lookAt(new THREE.Vector3().fromArray(sample.camera.targetM));
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); return camera;
}

function meshBounds(root: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3(); root.updateWorldMatrix(true, true);
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.gessoArtwork) return;
    const positions = object.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld));
  });
  return bounds;
}

function projectedInside(view: any, camera: THREE.PerspectiveCamera, fit: ProductWorldFit) {
  let closestEdge = Infinity;
  for (const root of view.components.values() as Iterable<THREE.Object3D>) {
    root.updateWorldMatrix(true, true);
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object.userData.gessoArtwork) return;
      const positions = object.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const ndc = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).project(camera);
        const gaps = [ndc.x - fit.targetRect.left, fit.targetRect.right - ndc.x, ndc.y - fit.targetRect.bottom, fit.targetRect.top - ndc.y];
        for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(-1e-7);
        closestEdge = Math.min(closestEdge, ...gaps);
      }
    });
  }
  return closestEdge;
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('world fitting through the actual viewport geometry', () => {
  it('measures transformed world and product meshes, includes hidden parts, and excludes artwork', async () => {
    const view = viewport(), scene = productScene(), sample = canonical(scene, 1);
    await view.makeProduct(scene, 1, new AbortController().signal); await view.frame(sample);
    const first = view.fitProductInWorld(sample, 1);
    for (const root of view.components.values()) root.visible = false;
    view.hiddenParts = new Set([...view.components.keys()]);
    const artwork = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial());
    artwork.userData.gessoArtwork = true; view.components.get('label').add(artwork);
    expect(view.fitProductInWorld(sample, 1)).toEqual(first);
    const productBounds = new THREE.Box3();
    for (const root of view.components.values()) productBounds.union(meshBounds(root));
    const expected = fitProductToWorld(cameraFor(sample, 1), meshBounds(view.worldFitRoot), productBounds,
      new THREE.Vector3().fromArray(sample.productPlacement.translationM), sample.productPlacement.scale);
    expect(first.multiplier).toBeCloseTo(expected.multiplier, 7);
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) expect(first.targetRect[edge]).toBeCloseTo(expected.targetRect[edge], 7);
    view.disposeObject(view.content);
  });

  it('uses the exact sampled shot and output aspect, independently of an inspected viewport camera', async () => {
    const view = viewport(), scene = productScene(), sample = canonical(scene);
    await view.makeProduct(scene, 1, new AbortController().signal); await view.frame(sample);
    const first = view.fitProductInWorld(sample, 9 / 16);
    view.inspectingCamera = true; view.camera.position.set(30, -4, 20); view.camera.lookAt(7, 2, 0);
    view.camera.fov = 112; view.camera.aspect = 3; view.camera.zoom = 1.7; view.camera.updateProjectionMatrix();
    view.camera.updateMatrixWorld(true);
    const before = view.camera.toJSON();
    await view.frame(sample);
    view.camera.updateMatrixWorld(true);
    expect(view.fitProductInWorld(sample, 9 / 16)).toEqual(first);
    expect(view.camera.toJSON()).toEqual(before);
    expect(view.fitProductInWorld(sample, .1).multiplier).toBeLessThan(first.multiplier);
    view.disposeObject(view.content);
  });

  it.each(['component', 'source subtree'])('excludes a removed %s while retaining eye-hidden parts and undo', async kind => {
    const view = viewport(), scene = productScene(), sample = canonical(scene, 1);
    await view.makeProduct(scene, 1, new AbortController().signal); await view.frame(sample);
    const original = view.fitProductInWorld(sample, 1);
    const removed = new THREE.Group(), nested = new THREE.Group();
    nested.add(new THREE.Mesh(new THREE.BoxGeometry(2, .1, 2), new THREE.MeshBasicMaterial()));
    removed.add(nested);
    const id = kind === 'component' ? 'discarded-plane' : 'bottle-body::node:999';
    if (kind === 'component') {view.components.set(id, removed); view.content.add(removed);}
    else view.components.get('bottle-body').add(removed);
    view.parts.set(id, removed);
    const includingPlane = view.fitProductInWorld(sample, 1);
    expect(includingPlane.multiplier).toBeLessThan(original.multiplier);
    view.hiddenParts = new Set([...view.components.keys()]);
    await view.frame({...sample, removedPartIds: [id]});
    expect(removed.visible).toBe(false);
    expect(view.fitProductInWorld(sample, 1)).toEqual(original);
    // Undo restores exactly the same source subtree; inspection eye state stays
    // hidden but must not keep the restored geometry out of the next fit.
    await view.frame(sample);
    expect(view.fitProductInWorld(sample, 1)).toEqual(includingPlane);
    expect(removed.children[0]).toBe(nested);
    view.disposeObject(view.content);
  });

  it.each(['static', 'legacy', 'film'] as const)('fits the %s pose, then reproduces it from saved scene scale using the export sampler', async mode => {
    const view = viewport(), scene = productScene();
    scene.placement.scale = 1.3;
    scene.environment.plinth.translationM = [.01, -.025, 0];
    if (mode === 'legacy') scene.animation = {tracks: [{id: 'product-scale', componentId: '$product', property: 'scale', enabled: true,
      keys: [{frame: 1, value: 1, interpolation: 'linear'}, {frame: 101, value: 2, interpolation: 'linear'}]}]};
    if (mode === 'film') scene.shots[0].motions = [{id: 'scale-motion', target: '$product', kind: 'scale', axis: 'y', amount: 1.5,
      startFrame: 1, durationFrames: 101, easing: 'linear', enabled: true}];
    const original = structuredClone(scene), sample = canonical(scene);
    await view.makeProduct(scene, 1, new AbortController().signal); await view.frame(sample);
    const geometry = [...view.components.values()].flatMap((root: THREE.Group) => root.children.filter(child => child instanceof THREE.Mesh)
      .map(child => ({mesh: child as THREE.Mesh, matrix: child.matrix.clone(), positions: [...(child as THREE.Mesh).geometry.attributes.position.array]})));
    const aspect = scene.render.width / scene.render.height, fit = view.fitProductInWorld(sample, aspect);
    const committed = applyProductWorldFit(scene, fit.multiplier), exported = canonical(committed);
    expect(exported.productPlacement.scale).toBeCloseTo(sample.productPlacement.scale * fit.multiplier, 10);
    expect(exported.productPlacement.translationM).toEqual(sample.productPlacement.translationM);
    expect(exported.camera).toEqual(sample.camera);
    await view.frame(exported);
    const again = view.fitProductInWorld(exported, aspect);
    expect(again.multiplier).toBeCloseTo(1, 9);
    projectedInside(view, cameraFor(exported, aspect), fit);
    for (const [id, root] of view.components as Map<string, THREE.Group>) {
      expect(root.position.toArray()).toEqual(exported.components[id].translationM);
      expect(root.scale.x).toBe(exported.components[id].scale);
    }
    for (const {mesh, matrix, positions} of geometry) {
      expect(mesh.matrix.equals(matrix)).toBe(true);
      expect([...mesh.geometry.attributes.position.array]).toEqual(positions);
    }
    expect(committed.product).toEqual(scene.product); expect(scene).toEqual(original);
    view.disposeObject(view.content);
  });

  it('rejects stale, incomplete, and non-scene inputs before changing anything', async () => {
    const view = viewport(), scene = productScene(), sample = canonical(scene, 1);
    await view.makeProduct(scene, 1, new AbortController().signal); await view.frame(sample);
    for (const flag of ['disposed', 'loading', 'loadFailed', 'awaitingSample']) {
      view[flag] = true; expect(() => view.fitProductInWorld(sample, 1)).toThrow(/finish loading/); view[flag] = false;
    }
    view.deferredWorld = {loading: true}; expect(() => view.fitProductInWorld(sample, 1)).toThrow(/finish loading/); view.deferredWorld = null;
    expect(() => view.fitProductInWorld({...sample, clip: {kind: 'image'}}, 1)).toThrow(/scene frame/);
    expect(() => view.fitProductInWorld({...sample, productPlacement: undefined}, 1)).toThrow(/scene frame/);
    const world = view.worldFitRoot; world.removeFromParent();
    expect(() => view.fitProductInWorld(sample, 1)).toThrow(/Choose a mesh world/);
    view.content.add(world); view.disposeObject(view.content);
  });
});
