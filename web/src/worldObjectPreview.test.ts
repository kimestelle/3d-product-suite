import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {createWorldObjectPreview, fitWorldObjectPreview, worldObjectPreviewKey} from './worldObjectPreview';
import {createComponentGeometry, disposeSceneObject, loadVerifiedGlb} from './sceneObjects';

const item = {id: 'prop-1', name: 'Box', object: {shape: 'box', sizeM: [.2, .1, .12], translationM: [1, 2, 3], rotationXyzw: [0, 0, 0, 1], bevelM: .002, material: {baseColor: [.4, .1, .1, 1], roughness: .4, metallic: .2}}};

function glb(extra: Record<string, unknown> = {}) {
  const coordinates = new Float32Array([-.01, -.02, -.003, .01, -.02, .003, 0, .02, 0]);
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Original hierarchy', translation: [.001, 0, 0], children: [1] }, { name: 'Original mesh', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Original red material', pbrMetallicRoughness: { baseColorFactor: [.8, .1, .05, 1], metallicFactor: .3, roughnessFactor: .2 } }],
    buffers: [{ byteLength: coordinates.byteLength }], bufferViews: [{ buffer: 0, byteLength: coordinates.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.01, -.02, -.003], max: [.01, .02, .003] }],
    ...extra,
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(28 + jsonLength + coordinates.byteLength);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonLength).fill(32); new Uint8Array(bytes, 20, json.length).set(json);
  header.setUint32(20 + jsonLength, coordinates.byteLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(bytes, 28 + jsonLength).set(new Uint8Array(coordinates.buffer));
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  return { bytes, asset: { format: 'glb', sourceUp: 'Y', sha256, path: `assets/${sha256}.glb` } };
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('world object previews', () => {
  it('uses declared dimensions and live physical material values', async () => {
    const object = await createWorldObjectPreview(item, new AbortController().signal) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    const dimensions = new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3());
    expect(dimensions.x).toBeCloseTo(.2, 6);
    expect(dimensions.y).toBeCloseTo(.1, 6);
    expect(dimensions.z).toBeCloseTo(.12, 6);
    expect(object.material.color.r).toBe(.4);
    expect(object.material.roughness).toBe(.4);
    expect(object.material.metalness).toBe(.2);
    expect(object.position.toArray()).toEqual([0, 0, 0]);
    disposeSceneObject(object);
  });
  it('shows a hidden plinth as an editable specimen without changing its visibility', async () => {
    const object = await createWorldObjectPreview({...item, isPlinth: true, object: {...item.object, visible: false}}, new AbortController().signal);
    expect(object.visible).toBe(true);
    disposeSceneObject(object);
  });
  it.each([[2, .01, .1], [.01, 2, .01], [.2, .1, .12]])('fits all rotated corners of %j without cropping', (x, y, z) => {
    const object = new THREE.Mesh(createComponentGeometry('box', [x, y, z]), new THREE.MeshStandardMaterial());
    object.position.set(10, -2, 5);
    object.rotation.set(.3, .7, -.2);
    const camera = new THREE.PerspectiveCamera(32);
    for (const aspect of [.7, 2, 4]) {
      fitWorldObjectPreview(camera, object, aspect);
      const box = new THREE.Box3().setFromObject(object, true);
      for (const xx of [box.min.x, box.max.x]) for (const yy of [box.min.y, box.max.y]) for (const zz of [box.min.z, box.max.z]) {
        const projected = new THREE.Vector3(xx, yy, zz).project(camera);
        expect(Math.abs(projected.x)).toBeLessThanOrEqual(.780001);
        expect(Math.abs(projected.y)).toBeLessThanOrEqual(.780001);
        expect(projected.z).toBeGreaterThan(-1);
        expect(projected.z).toBeLessThan(1);
      }
    }
    disposeSceneObject(object);
  });
  it('does not recapture for renames, visibility or translations but does for material and size edits', () => {
    const key = worldObjectPreviewKey(item);
    expect(worldObjectPreviewKey({...item, name: 'Renamed', object: {...item.object, visible: false, translationM: [4, 5, 6]}})).toBe(key);
    expect(worldObjectPreviewKey({...item, object: {...item.object, sizeM: [1, 1, 1]}})).not.toBe(key);
    expect(worldObjectPreviewKey({...item, object: {...item.object, material: {...item.object.material, roughness: .9}}})).not.toBe(key);
  });
  it.each([false, true])('retains imported geometry, native hierarchy, instance rotation/scaling and override=%s', async materialOverride => {
    const fixture = glb();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const importedItem = {...item, name: 'Imported prop', object: {...item.object, shape: 'mesh', materialOverride,
      asset: {...fixture.asset, sourceDimensionsM: [.02, .04, .006]}, sizeM: [.04, .12, .024], rotationXyzw: rotation.toArray()}};
    const before = structuredClone(importedItem);
    const signal = new AbortController().signal;
    const fetch = vi.fn(async () => new Response(fixture.bytes)); vi.stubGlobal('fetch', fetch);
    const object = await createWorldObjectPreview(importedItem, signal);
    try {
      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/assets/${fixture.asset.sha256}.glb`, {signal, credentials: 'same-origin'});
      expect(object.scale.toArray()).toEqual([2, 3, 4]);
      expect(object.quaternion.toArray()).toEqual(rotation.toArray());
      expect(object.position.toArray()).toEqual([0, 0, 0]);
      const mesh = object.getObjectByProperty('isMesh', true) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      expect(mesh.parent!.position.x).toBe(.001);
      expect(mesh.geometry.getAttribute('position').count).toBe(3);
      expect(mesh.userData.gessoSourceNode).toEqual({index: 1, name: 'Original mesh'});
      const material = mesh.material;
      if (materialOverride) {
        expect(material.color.toArray()).toEqual([.4, .1, .1]);
        expect(material.roughness).toBe(.4);
        expect(material.metalness).toBe(.2);
      } else {
        expect(material.name).toBe('Original red material');
        expect(material.color.toArray()).toEqual([.8, .1, .05]);
        expect(material.roughness).toBe(.2);
        expect(material.metalness).toBe(.3);
      }
      const dimensions = new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3());
      expect(dimensions.x).toBeCloseTo(.024, 7);
      expect(dimensions.y).toBeCloseTo(.12, 7);
      expect(dimensions.z).toBeCloseTo(.04, 7);
      expect(importedItem).toEqual(before);
    } finally {disposeSceneObject(object);}
  });
  it('rejects imported dimension metadata that disagrees with verified source geometry', async () => {
    const fixture = glb(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    const importedItem = {...item, object: {...item.object, shape: 'mesh', materialOverride: false,
      asset: {...fixture.asset, sourceDimensionsM: [1, 1, 1]}}};
    await expect(createWorldObjectPreview(importedItem, new AbortController().signal)).rejects.toThrow('Imported prop dimensions do not match its verified GLB geometry.');
  });
  it('rejects unsafe imported asset paths before making any request', async () => {
    await expect(loadVerifiedGlb({format: 'glb', sourceUp: 'Y', sha256: 'a'.repeat(64), path: '../escape.glb'}, new AbortController().signal)).rejects.toThrow('safe, content-addressed Y-up GLB');
  });
  it('does not construct a stale primitive after cancellation', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(createWorldObjectPreview(item, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
  });
});
