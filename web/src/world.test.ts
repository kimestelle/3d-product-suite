import {describe, expect, it} from 'vitest';
import {Euler, Quaternion} from 'three';
import fixture from '../../examples/bottle.scene.json';
import {addProp, addPropFromLibrary, setHdriFromLibrary, colorFromHex, colorHex, defaultLighting, ensureLighting, resizeProp, setPropShape, setWorldYaw, worldYaw} from './world';

describe('World editing', () => {
  it('derives canonical legacy Cycles lighting without changing saved scenes', () => {
    const scene = structuredClone(fixture); const before = JSON.stringify(scene);
    const rig = defaultLighting(scene); const scale = .137 / .12;
    expect(JSON.stringify(scene)).toBe(before);
    expect(rig.ambientStrength).toBe(.45);
    expect(rig.lights.map(light => light.id)).toEqual(['key', 'fill', 'rim']);
    expect(rig.lights[0].positionM).toEqual([-.19 * scale, .32 * scale, .24 * scale]);
    expect(rig.lights[0].powerW).toBeCloseTo(2.6 * scale ** 2);
    expect(rig.lights[0].targetM).toEqual([0, .137 * .52, 0]);
  });
  it('persists only a requested lighting edit and keeps independently editable light vectors', () => {
    const scene: any = structuredClone(fixture);
    ensureLighting(scene).lights[0].targetM[0] = .1;
    expect(ensureLighting(scene).lights[0].targetM[0]).toBe(.1);
    expect(scene.lighting.lights[1].targetM[0]).toBe(0);
    expect(scene.lighting.lights[0].positionM[0]).not.toBe(.1);
  });
  it('creates independent props with collision-free IDs on the support top', () => {
    const scene: any = structuredClone(fixture);
    scene.product.components[0].id = 'prop-1';
    expect(addProp(scene, 'cylinder')).toBe('prop-2');
    expect(addProp(scene, 'box')).toBe('prop-3');
    const [a, b] = scene.environment.props;
    expect(a.translationM[1] - a.sizeM[1] / 2).toBeCloseTo(0);
    expect(a.sizeM[0]).toBe(a.sizeM[2]);
    a.material.baseColor[0] = 0;
    expect(b.material.baseColor[0]).toBe(.56);
  });
  it('keeps cylinder diameter coupled and clamps bevel when resizing', () => {
    const scene: any = structuredClone(fixture); addProp(scene, 'box');
    const prop = scene.environment.props[0]; prop.sizeM = [.1, .2, .3]; prop.bevelM = .01;
    setPropShape(prop, 'cylinder'); expect(prop.sizeM).toEqual([.1, .2, .1]);
    resizeProp(prop, 2, .002); expect(prop.sizeM).toEqual([.002, .2, .002]); expect(prop.bevelM).toBe(.001);
    resizeProp(prop, 1, -1); expect(prop.sizeM[1]).toBe(.001); expect(prop.bevelM).toBe(.0005);
  });
  it('changes yaw without discarding world pitch and roll', () => {
    const q = new Quaternion().setFromEuler(new Euler(.2, .3, -.1, 'YXZ'));
    const asset = {rotationXyzw: q.toArray()}; setWorldYaw(asset, 70);
    const rotation = new Euler().setFromQuaternion(new Quaternion().fromArray(asset.rotationXyzw), 'YXZ');
    expect(worldYaw(asset)).toBeCloseTo(70); expect(rotation.x).toBeCloseTo(.2); expect(rotation.z).toBeCloseTo(-.1);
  });
  it('uses sRGB for the color input and linear color in the saved scene', () => {
    expect(colorHex([.5, .5, .5])).toBe('#bcbcbc');
    expect(colorFromHex('#808080')[0]).toBeCloseTo(.21586, 4);
  });
});


describe('world library edits', () => {
  it('stores imported props independently with original dimensions and CC0 credit', () => {
    const scene: any = structuredClone(fixture), entry = { id: 'jar', name: 'Glass jar', sourceUrl: 'https://polyhaven.com/a/jar',
      asset: { path: 'assets/model.glb', format: 'glb', sourceDimensionsM: [.1, .2, .1] }, sizeM: [.1, .2, .1] };
    const id = addPropFromLibrary(scene, entry), prop = scene.environment.props[0];
    expect(prop.id).toBe(id); expect(prop.shape).toBe('mesh'); expect(prop.materialOverride).toBe(false);
    expect(prop.asset.sourceDimensionsM).toEqual(entry.sizeM); expect(prop.sizeM).not.toBe(entry.sizeM);
    expect(prop.translationM[1] - prop.sizeM[1] / 2).toBeCloseTo(scene.environment.plinth.translationM[1] + scene.environment.plinth.sizeM[1] / 2);
    resizeProp(prop, 0, .3); expect(prop.asset.sourceDimensionsM[0]).toBe(.1);
    expect(prop.source).toEqual({ provider: 'Poly Haven', assetId: 'jar', url: entry.sourceUrl, license: 'CC0' });
  });
  it('adds HDR lighting without changing the scene background or light rig', () => {
    const scene: any = structuredClone(fixture); const background = [...scene.environment.worldColor];
    const entry = { name: 'Studio', sourceUrl: 'https://polyhaven.com/a/studio', asset: { path: 'assets/light.hdr', format: 'hdr', sha256: 'x' } };
    setHdriFromLibrary(scene, entry);
    expect(scene.lighting.hdri).toEqual({ ...entry, intensity: 1, rotationDeg: 0 });
    expect(scene.lighting.lights).toHaveLength(3); expect(scene.environment.worldColor).toEqual(background);
    expect(scene.lighting.hdri.asset).not.toBe(entry.asset);
  });
});
