import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasUvOverlap, uvBarycentricWeights } from './decals';
import { StudioViewport } from './viewport';

function viewport() {
  // Real Three geometry and preview lifecycle, without a WebGL context.
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  Object.assign(view, {
    scene, content, camera: new THREE.PerspectiveCamera(40, 1.4, .001, 100),
    canvas: { style: {}, clientHeight: 800, clientWidth: 1120, removeEventListener: vi.fn() },
    options: { studioMode: true, capture: false },
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
function addPart(view: any, id = 'body', geometry: THREE.BufferGeometry = new THREE.PlaneGeometry(.2, .2)) {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; root.add(mesh);
  view.content.add(root); view.components.set(id, root); view.parts.set(id, root);
  root.traverse(object => view.originalVisibility.set(object, object.visible));
  return { root, mesh, material };
}
function triangle(uv: number[], positions = [0, 0, 0, .1, 0, 0, 0, .1, 0]) {
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('UV surface probe', () => {
  it('interpolates within either winding and rejects empty, degenerate and nonfinite UV regions', () => {
    expect(uvBarycentricWeights([0, 0, 1, 0, 0, 1], [.2, .3])).toEqual([.5, .2, .3]);
    expect(uvBarycentricWeights([0, 0, 0, 1, 1, 0], [.2, .3])).toEqual([.49999999999999994, .3, .2]);
    expect(uvBarycentricWeights([0, 0, 1, 0, 0, 1], [.8, .8])).toBeNull();
    expect(uvBarycentricWeights([0, 0, 0, 0, 0, 0], [0, 0])).toBeNull();
    expect(uvBarycentricWeights([0, 0, 1, 0, 0, 1], [NaN, .2])).toBeNull();
    expect(uvBarycentricWeights([0, 0, 1e308, 0, 0, 1e308], [.2, .3])).toBeNull();
  });

  it('places a small overlay at the source surface and deduplicates a shared triangle diagonal', () => {
    const view = viewport(), { mesh } = addPart(view);
    view.setUvProbePart('body'); view.setUvProbe([.25, .75]);
    expect(view.uvProbeSprites).toHaveLength(1);
    const sprite = view.uvProbeSprites[0] as THREE.Sprite;
    expect(sprite.parent).toBe(mesh);
    expect(sprite.position.x).toBeCloseTo(-.05); expect(sprite.position.y).toBeCloseTo(.05); expect(sprite.position.z).toBe(0);
    expect(sprite.material.depthTest).toBe(false); expect(sprite.material.depthWrite).toBe(false); expect(sprite.renderOrder).toBe(1000);
    expect(sprite.material.color.getHex()).toBe(0xff2020);
    const pixels = (sprite.material.map!.image as { data: Uint8Array }).data;
    // Solid center, clear gap, solid ring, clear outside: no radial glow.
    expect([32, 44, 54, 60].map(x => pixels[(32 * 64 + x) * 4 + 3])).toEqual([255, 0, 255, 0]);
    expect(sprite.scale.x * view.camera.projectionMatrix.elements[5] * 800 / 2).toBeCloseTo(18);
    view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(1);
    expect(sprite.parent).toBeNull();
    expect(view.getUvLayout('body').triangleCount).toBe(2); // Markers never become source UVs.
  });

  it('preserves distinct stacked surfaces and follows their actual sampled parent poses', async () => {
    const view = viewport(), { root, mesh } = addPart(view);
    const back = mesh.clone(); back.position.z = -.02; root.add(back);
    view.setUvProbePart('body'); view.setUvProbe([.25, .75]);
    expect(view.uvProbeSprites).toHaveLength(2);
    vi.stubGlobal('document', { hidden: true });
    await view.frame({ components: { body: { translationM: [.4, .5, .6], rotationXyzw: [0, 0, 1, 0] } },
      camera: { positionM: [0, 0, 1], targetM: [0, 0, 0], focalLengthMm: 50 } });
    const points = view.uvProbeSprites.map((sprite: THREE.Sprite) => sprite.getWorldPosition(new THREE.Vector3()));
    expect(points[0].x).toBeCloseTo(.45); expect(points[0].y).toBeCloseTo(.45);
    expect(points[0].z).toBeCloseTo(.6); expect(points[1].z).toBeCloseTo(.58);
  });

  it('does not invent hits between islands or on source parts without UVs', () => {
    const view = viewport(); const { mesh } = addPart(view, 'body', triangle([.1, .1, .3, .1, .1, .3]));
    view.setUvProbePart('body'); view.setUvProbe([.2, .15]); expect(view.uvProbeSprites).toHaveLength(1);
    view.setUvProbe([.8, .8]); expect(view.uvProbeSprites).toHaveLength(0);
    mesh.geometry.deleteAttribute('uv'); view.setUvProbePart('body'); view.setUvProbe([.2, .15]);
    expect(view.uvProbeSprites).toHaveLength(0);
  });

  it('queries full geometry after the wireframe display reaches its 6000-triangle limit', () => {
    const view = viewport(), positions: number[] = [], uv: number[] = [];
    for (let i = 0; i < 6001; i++) {
      positions.push(0, 0, i * .001, .1, 0, i * .001, 0, .1, i * .001);
      uv.push(...(i < 6000 ? [0, 0, .1, 0, 0, .1] : [.6, .6, .8, .6, .6, .8]));
    }
    addPart(view, 'body', triangle(uv, positions));
    expect(view.getUvLayout('body')).toMatchObject({ truncated: true, triangleCount: 6001 });
    view.setUvProbePart('body'); view.setUvProbe([.65, .65]);
    expect(view.uvProbeSprites).toHaveLength(1); expect(view.uvProbeSprites[0].position.z).toBeCloseTo(6);
  });

  it('bounds indexing for huge finite GLB UVs and rejects API coordinates outside the displayed tile', () => {
    const view = viewport(); const { root } = addPart(view, 'body', triangle([1e20, 1e20, 1.1e20, 1e20, 1e20, 1.1e20]));
    root.add(new THREE.Mesh(triangle([-1e20, -1e20, 1e20, -1e20, 0, 1e20]), new THREE.MeshStandardMaterial()));
    expect(hasUvOverlap([[1e20, 1e20, 1.1e20, 1e20, 1e20, 1.1e20]])).toBe(false);
    view.setUvProbePart('body');
    expect(view.uvProbeSources[0].buckets.size).toBe(0); expect(view.uvProbeSources[1].wide).toHaveLength(1);
    view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(1);
    for (const uv of [[1e20, 1e20], [-.01, .5], [.5, 1.01], [NaN, .5]]) {
      view.setUvProbe(uv); expect(view.uvProbeSprites).toHaveLength(0);
    }
  });

  it('fades selected source and its artwork with focus off, then restores materials without disposing shared textures', () => {
    const view = viewport(), { mesh, material } = addPart(view), other = addPart(view, 'cap');
    const artworkMaterial = new THREE.MeshBasicMaterial({ opacity: .8, transparent: true, map: new THREE.Texture() });
    const artwork = new THREE.Mesh(new THREE.PlaneGeometry(.01, .01), artworkMaterial); artwork.userData.gessoArtwork = true; mesh.add(artwork);
    const sourceDispose = vi.spyOn(material, 'dispose'), textureDispose = vi.spyOn(material.map!, 'dispose');
    view.setUvProbePart('body');
    expect(mesh.material).not.toBe(material); expect(mesh.material.opacity).toBeCloseTo(.72);
    expect(mesh.material.map).toBe(material.map); expect(material.opacity).toBe(1);
    expect(artwork.material.opacity).toBeCloseTo(.8 * .72); expect(other.mesh.material).toBe(other.material);
    expect(mesh.castShadow).toBe(false);
    view.setSelection('body'); view.setPartFocus(true); expect(other.mesh.material.opacity).toBeCloseTo(.18);
    view.setUvProbePart(null); expect(mesh.material).toBe(material); expect(artwork.material).toBe(artworkMaterial);
    expect(other.mesh.material.opacity).toBeCloseTo(.18);
    view.setPartFocus(false); expect(other.mesh.material).toBe(other.material); expect(mesh.castShadow).toBe(true);
    expect(sourceDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled();
  });

  it('clears on part changes and mode exit, and never probes hidden parts', () => {
    const view = viewport(); addPart(view); addPart(view, 'cap');
    view.setUvProbePart('body'); view.setUvProbe([.5, .5]);
    const previous = view.uvProbeSprites[0];
    view.setUvProbePart('cap'); expect(previous.parent).toBeNull(); expect(view.uvProbeSprites).toHaveLength(0);
    view.setHiddenParts(['cap']); view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(0);
    view.setHiddenParts([]); view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(1);
    view.setUvProbePart(null); expect(view.uvProbeSprites).toHaveLength(0);
    view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(0);
  });

  it('never affects capture or nonstudio presentation, and blocks stale probes until a sampled scene is ready', () => {
    const view = viewport(), { mesh, material } = addPart(view);
    for (const options of [{ studioMode: false, capture: false }, { studioMode: true, capture: true }]) {
      view.options = options; view.setUvProbePart('body'); view.setUvProbe([.5, .5]);
      expect(view.uvProbeSprites).toHaveLength(0); expect(mesh.material).toBe(material);
    }
    view.options = { studioMode: true }; view.setUvProbePart('body');
    for (const flag of ['loading', 'loadFailed', 'awaitingSample', 'disposed']) {
      view[flag] = true; view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(0); view[flag] = false;
    }
    view.setUvProbe([.5, .5]); expect(view.uvProbeSprites).toHaveLength(1);
  });

  it('clears source references on reload and disposes the reusable marker material only at teardown', () => {
    const view = viewport(); addPart(view); view.setUvProbePart('body'); view.setUvProbe([.5, .5]);
    const marker = view.uvProbeSprites[0], material = marker.material;
    const materialDispose = vi.spyOn(material, 'dispose'), textureDispose = vi.spyOn(material.map, 'dispose');
    view.clearContent(true);
    expect(marker.parent).toBeNull(); expect(view.uvProbeSources).toEqual([]); expect(view.uvProbeSprites).toEqual([]);
    expect(materialDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled();
    addPart(view); view.rebuildUvProbeIndex(); view.setUvProbe([.5, .5]);
    expect(view.uvProbeSprites[0].material).toBe(material);
    vi.stubGlobal('document', { removeEventListener: vi.fn() });
    view.dispose(); expect(materialDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce();
  });
});
