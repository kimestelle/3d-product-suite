import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioViewport } from './viewport';
import type { MaterialSpecification } from './materials';

const red: MaterialSpecification = { baseColor: [.9, .03, .02, 1], roughness: .23, metallic: .7 };
function viewport() {
  // Real scene objects and material lifecycle; only the WebGL output is absent.
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  Object.assign(view, {
    scene, content, camera: new THREE.PerspectiveCamera(40, 1.4, .001, 100),
    canvas: { style: {}, clientHeight: 800, clientWidth: 1120, removeEventListener: vi.fn() },
    options: { studioMode: true, capture: false, onError: vi.fn(), onReady: vi.fn() },
    parts: new Map(), components: new Map(), environmentObjects: new Map(),
    originalVisibility: new Map(), focusMaterials: new Map(), previewMaterials: new Set(),
    hiddenParts: new Set(), focusPartIds: [], partFocus: false, selectedId: null,
    selection: null, framedSelection: false, inspectingCamera: false, controls: null,
    controlListeners: null, sampledCamera: null, inspectionEnabled: true,
    disposed: false, loading: false, loadFailed: false, awaitingSample: false,
    loadVersion: 1, frameRequest: 0, frameQueue: Promise.resolve(), liveRender: null,
    dirty: false, visible: false, productPreview: false, productGround: null,
    environmentBackground: null, worldReady: false, resizeObserver: { disconnect: vi.fn() },
    renderer: { renderLists: { dispose: vi.fn() }, dispose: vi.fn(), forceContextLoss: vi.fn() },
  });
  view.invalidate = vi.fn();
  return view;
}
function addPart(view: any, id = 'body') {
  const root = new THREE.Group(); root.userData.gessoPrimitiveShape = 'box';
  const texture = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map: texture, roughness: .8 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.2, .2, .2), material); mesh.castShadow = true; root.add(mesh);
  view.content.add(root); view.components.set(id, root); view.parts.set(id, root);
  root.traverse(object => view.originalVisibility.set(object, object.visible));
  return { root, mesh, material, texture };
}
function textureFixture(seed = 0) {
  const bytes = new ArrayBuffer(33), header = new DataView(bytes);
  header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a); header.setUint32(8, 13);
  header.setUint32(12, 0x49484452); header.setUint32(16, 2); header.setUint32(20, 2); header.setUint8(32, seed);
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  return { bytes, material: { ...red, textures: { basecolor: { path: `assets/${sha256}.png`, sha256, format: 'png' as const } } } };
}
function bitmap() { return { width: 2, height: 2, close: vi.fn() }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('material drafts on the real product', () => {
  it('previews an imported section without spilling into sibling sections and restores its original slots', async () => {
    const view = viewport(), body = addPart(view); body.root.userData.gessoPrimitiveShape = 'mesh';
    const other = new THREE.Mesh(new THREE.BoxGeometry(), body.material); body.root.add(other);
    const slots = [body.material, new THREE.MeshStandardMaterial()]; (body.mesh as THREE.Mesh).material = slots;
    view.parts.set('body::node:1', body.mesh); view.parts.set('body::node:2', other);
    await view.setMaterialPreview({ componentIds: ['body::node:1'], material: red, presetId: 'red' });
    expect(body.mesh.material).not.toBe(slots); expect(other.material).toBe(body.material);
    await view.setMaterialPreview(null);
    expect(body.mesh.material).toBe(slots); expect(other.material).toBe(body.material);
  });

  it('keeps descendant bindings to another preset intact while previewing a parent material', async () => {
    const view = viewport(), body = addPart(view);
    const bound = new THREE.Group(); bound.userData.gessoMaterialBindingPresetId = 'rubber';
    const insert = new THREE.Mesh(new THREE.BoxGeometry(), body.material); bound.add(insert); body.root.add(bound);
    const same = new THREE.Mesh(new THREE.BoxGeometry(), body.material); same.userData.gessoMaterialBindingPresetId = 'steel'; body.root.add(same);
    view.parts.set('body::node:1', bound);
    await view.setMaterialPreview({ componentIds: ['body'], material: red, presetId: 'steel' });
    const preview = view.materialPreviewState.applied.material;
    expect(body.mesh.material).toBe(preview); expect(same.material).toBe(preview);
    expect(insert.material).toBe(body.material);
    await view.setMaterialPreview({ componentIds: ['body::node:1'], material: red, presetId: 'rubber' });
    expect(insert.material).toBe(view.materialPreviewState.applied.material);
    expect(body.mesh.material).toBe(body.material); expect(same.material).toBe(body.material);
  });

  it('previews linked parts without touching artwork, geometry, source materials or the camera; cancel restores exact arrays', async () => {
    const view = viewport(), body = addPart(view), cap = addPart(view, 'cap');
    const originalArray = [body.material, new THREE.MeshStandardMaterial()];
    (body.mesh as THREE.Mesh).material = originalArray;
    const ink = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()); ink.userData.gessoArtwork = true;
    const nestedInk = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()); ink.add(nestedInk); body.mesh.add(ink);
    const inkMaterial = ink.material, nestedMaterial = nestedInk.material, geometry = body.mesh.geometry;
    const camera = view.camera.matrix.clone(), sourceDispose = vi.spyOn(body.texture, 'dispose');
    const draft = { componentIds: ['body', 'cap'], material: structuredClone(red) };
    const pending = view.setMaterialPreview(draft); draft.material.roughness = .99;
    await pending;
    const applied = view.materialPreviewState.applied.material as THREE.MeshPhysicalMaterial;
    const dispose = vi.spyOn(applied, 'dispose');
    expect((body.mesh as THREE.Mesh).material).toEqual([applied, applied]); expect(cap.mesh.material).toBe(applied);
    expect(applied.roughness).toBe(.23); expect(applied.metalness).toBe(.7);
    expect(applied.color.toArray()).toEqual(red.baseColor.slice(0, 3));
    expect(ink.material).toBe(inkMaterial); expect(nestedInk.material).toBe(nestedMaterial);
    expect(body.mesh.geometry).toBe(geometry); expect(view.camera.matrix).toEqual(camera);
    expect(body.material.roughness).toBe(.8); expect(sourceDispose).not.toHaveBeenCalled();
    await view.setMaterialPreview(null);
    expect((body.mesh as THREE.Mesh).material).toBe(originalArray); expect(cap.mesh.material).toBe(cap.material);
    expect(body.mesh.castShadow).toBe(true); expect(dispose).toHaveBeenCalledOnce(); expect(sourceDispose).not.toHaveBeenCalled();
  });

  it('composes focus and UV-probe opacity around the draft and restores shadow flags without disposing source maps', async () => {
    const view = viewport(), body = addPart(view); addPart(view, 'cap');
    view.setFocusParts(['cap']); view.setPartFocus(true);
    await view.setMaterialPreview({ componentIds: ['body'], material: red });
    const applied = view.materialPreviewState.applied.material;
    expect(body.mesh.material).not.toBe(applied); expect(body.mesh.material.opacity).toBe(.18); expect(body.mesh.castShadow).toBe(false);
    view.setPartFocus(false); expect(body.mesh.material).toBe(applied); expect(body.mesh.castShadow).toBe(true);
    view.setUvProbePart('body'); expect(body.mesh.material.opacity).toBe(.72);
    await view.setMaterialPreview(null); expect(body.mesh.material.opacity).toBe(.72);
    view.setUvProbePart(null); expect(body.mesh.material).toBe(body.material); expect(body.mesh.castShadow).toBe(true);
  });

  it('requires an explicit imported-material override and never previews in capture mode', async () => {
    const view = viewport(), body = addPart(view); body.root.userData.gessoPrimitiveShape = 'mesh';
    await expect(view.setMaterialPreview({ componentIds: ['body'], material: red })).rejects.toThrow('editable product part');
    expect(body.mesh.material).toBe(body.material); expect(view.options.onError).not.toHaveBeenCalled();
    body.root.userData.gessoMaterialOverride = true;
    await view.setMaterialPreview({ componentIds: ['body'], material: red }); expect(body.mesh.material).not.toBe(body.material);
    await view.setMaterialPreview(null); view.options.capture = true;
    await view.setMaterialPreview({ componentIds: ['body'], material: red }); expect(body.mesh.material).toBe(body.material);
  });

  it('keeps the current preview visible until all maps decode and rejects stale rapid replacements', async () => {
    const view = viewport(), body = addPart(view), a = textureFixture(1), b = textureFixture(2);
    vi.stubGlobal('fetch', async (url: string) => new Response(url.includes(a.material.textures.basecolor.sha256) ? a.bytes : b.bytes));
    const finish: Array<(value: unknown) => void> = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => finish.push(resolve))));
    await view.setMaterialPreview({ componentIds: ['body'], material: red }); const first = body.mesh.material;
    const disposeFirst = vi.spyOn(first, 'dispose');
    const requestA = view.setMaterialPreview({ componentIds: ['body'], material: a.material });
    await vi.waitFor(() => expect(finish).toHaveLength(1)); const runningA = view.materialPreviewState.running.promise;
    expect(body.mesh.material).toBe(first);
    const requestB = view.setMaterialPreview({ componentIds: ['body'], material: b.material });
    await vi.waitFor(() => expect(finish).toHaveLength(2)); expect(body.mesh.material).toBe(first);
    const imageB = bitmap(); finish[1](imageB); await requestB;
    const latest = body.mesh.material as THREE.MeshPhysicalMaterial;
    expect(latest.map?.image).toBe(imageB); expect(disposeFirst).toHaveBeenCalledOnce();
    const imageA = bitmap(); finish[0](imageA); await runningA; await requestA;
    expect(body.mesh.material).toBe(latest); expect(imageA.close).toHaveBeenCalledOnce();
    const disposeTexture = vi.spyOn(latest.map!, 'dispose');
    await view.setMaterialPreview(null);
    expect(body.mesh.material).toBe(body.material); expect(disposeTexture).toHaveBeenCalledOnce(); expect(imageB.close).toHaveBeenCalledOnce();
  });

  it('keeps a working preview on texture failure and reports only through the preview promise', async () => {
    const view = viewport(), body = addPart(view), fixture = textureFixture();
    await view.setMaterialPreview({ componentIds: ['body'], material: red }); const working = body.mesh.material;
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(view.setMaterialPreview({ componentIds: ['body'], material: fixture.material })).rejects.toThrow('404');
    expect(body.mesh.material).toBe(working); expect(view.loadFailed).toBe(false); expect(view.options.onError).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'clearScene', 'dispose'])('releases late texture decodes after %s without reinstalling the draft', async action => {
    const view = viewport(), body = addPart(view), fixture = textureFixture();
    vi.stubGlobal('document', { removeEventListener: vi.fn() });
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    let finish!: (value: unknown) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const request = view.setMaterialPreview({ componentIds: ['body'], material: fixture.material });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); const running = view.materialPreviewState.running.promise;
    if (action === 'cancel') await view.setMaterialPreview(null); else view[action]();
    const image = bitmap(); finish(image); await running; await request;
    expect(view.materialPreviewState.applied).toBeNull(); expect(image.close).toHaveBeenCalledOnce();
    expect(body.mesh.material).toBe(body.material); expect(view.materialPreviewState.descriptor).toBeNull();
  });

  it('reapplies the latest descriptor during canonical reload before the first sampled frame, leaving the scene unchanged', async () => {
    const view = viewport(), original = addPart(view);
    const source = {
      placement: { translationM: [0, 0, 0] },
      product: { dimensionsM: [.2, .2, .2], components: [{ id: 'body', shape: 'box', sizeM: [.2, .2, .2], bevelM: 0,
        assembly: { translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1] }, material: { ...red, roughness: .6 } }] },
      environment: { kind: 'authored', worldColor: [.1, .2, .3], plinth: { sizeM: [1, .1, 1], translationM: [0, -.05, 0] } },
    };
    const sourceBefore = structuredClone(source);
    await view.setMaterialPreview({ componentIds: ['body'], material: red });
    const disposeOld = vi.spyOn(original.mesh.material, 'dispose');
    let finishFonts!: () => void;
    vi.stubGlobal('document', { fonts: { load: vi.fn(() => new Promise<void>(resolve => { finishFonts = resolve; })) } });
    const loading = view.load(source); let previewSettled = false;
    const pending = view.setMaterialPreview({ componentIds: ['body'], material: { ...red, roughness: .11 } }).then(() => { previewSettled = true; });
    await Promise.resolve(); expect(previewSettled).toBe(false); expect(view.awaitingSample).toBe(true);
    finishFonts(); await loading; await pending;
    const freshMesh = view.components.get('body').children[0] as THREE.Mesh;
    expect((freshMesh.material as THREE.MeshPhysicalMaterial).roughness).toBe(.11);
    expect(disposeOld).toHaveBeenCalledOnce(); expect(view.options.onReady).toHaveBeenCalledOnce();
    expect(view.awaitingSample).toBe(true); expect(source).toEqual(sourceBefore);
    // Saving replaces the canonical product but must keep the same preview
    // descriptor installed until the editor explicitly clears it.
    const saved = structuredClone(source); saved.product.components[0].material.roughness = .11;
    vi.stubGlobal('document', { fonts: { load: vi.fn(async () => []) } });
    await view.load(saved);
    const savedMesh = view.components.get('body').children[0] as THREE.Mesh;
    expect(savedMesh.material).toBe(view.materialPreviewState.applied.material);
    expect((savedMesh.material as THREE.MeshPhysicalMaterial).roughness).toBe(.11);
    await view.setMaterialPreview(null);
    expect(savedMesh.material).not.toBe(freshMesh.material);
    expect((savedMesh.material as THREE.MeshPhysicalMaterial).roughness).toBe(.11);
  });
});

describe('material hover around an unsaved surface draft', () => {
  it('preserves the current draft when hover leaves and restores saved materials when the draft is cancelled', async () => {
    const view = viewport(), body = addPart(view), cap = addPart(view, 'cap');
    view.setSelection('cap'); view.setFocusParts(['cap']);
    const bodyTextureDispose = vi.spyOn(body.texture, 'dispose'), capTextureDispose = vi.spyOn(cap.texture, 'dispose');
    view.setMaterialHover({ presetId: 'cap', partIds: ['cap'] });
    await view.setMaterialPreview({ componentIds: ['body'], presetId: 'body', material: red });
    const draftMaterial = view.materialPreviewState.applied.material;
    expect(body.mesh.material).not.toBe(draftMaterial); expect(body.mesh.material.opacity).toBe(.18);
    expect(body.mesh.material.color.toArray()).toEqual(red.baseColor.slice(0, 3)); expect(cap.mesh.material).toBe(cap.material);
    view.setMaterialHover(null);
    expect(body.mesh.material).toBe(draftMaterial); expect(body.mesh.castShadow).toBe(true);
    view.setMaterialHover({ presetId: 'body', partIds: ['body'] });
    expect(body.mesh.material).toBe(draftMaterial); expect(cap.mesh.material.opacity).toBe(.18);
    const draftDispose = vi.spyOn(draftMaterial, 'dispose');
    await view.setMaterialPreview(null);
    expect(body.mesh.material).toBe(body.material); expect(cap.mesh.material.opacity).toBe(.18);
    expect(draftDispose).toHaveBeenCalledOnce();
    view.setMaterialHover(null);
    expect(body.mesh.material).toBe(body.material); expect(cap.mesh.material).toBe(cap.material);
    expect(body.mesh.castShadow).toBe(true); expect(cap.mesh.castShadow).toBe(true);
    expect(bodyTextureDispose).not.toHaveBeenCalled(); expect(capTextureDispose).not.toHaveBeenCalled();
    expect(view.selectedId).toBe('cap'); expect(view.focusPartIds).toEqual(['cap']); expect(view.partFocus).toBe(false);
  });
});
