import {describe, expect, it} from 'vitest';
import {Euler, Quaternion} from 'three';
import fixture from '../../examples/bottle.scene.json';
import {addLight, addProp, addPropFromLibrary, applyDramaticSpot, setHdriFromLibrary, colorFromHex, colorHex, defaultLighting, ensureLighting, isLightTarget, lightIdFromTarget, lightTarget, removeLight, resizeProp, setLightType, setPropShape, setWorldYaw, worldYaw} from './world';

describe('World editing', () => {
  it('uses the fixed stage reference for default and newly added lights', () => {
    const scenes = [1, 1000].map(factor => {
      const scene: any = structuredClone(fixture);
      scene.environment.studioSizeM = .32;
      scene.product.dimensionsM = [.32, .16, .24].map(value => value * factor);
      scene.placement.scale = 1 / factor;
      if (factor === 1000) scene.placement.translationM = [4, 5, -1.28];
      return scene;
    });
    expect(defaultLighting(scenes[0])).toEqual(defaultLighting(scenes[1]));
    expect(defaultLighting(scenes[0]).lights[0].targetM).toEqual([0, .32 * .52, 0]);
    for (const scene of scenes) {addLight(scene, 'spot'); addLight(scene, 'area');}
    expect(scenes[0].lighting).toEqual(scenes[1].lighting);
    for (const scene of scenes) applyDramaticSpot(scene);
    expect(scenes[0].lighting).toEqual(scenes[1].lighting);
  });
  it('places new primitives and library props within the fixed stage', () => {
    const scenes = [1, 1000].map(factor => {
      const scene: any = structuredClone(fixture);
      scene.environment.studioSizeM = .32;
      scene.product.dimensionsM = [.32, .16, .24].map(value => value * factor);
      return scene;
    });
    const entry = {id: 'jar', name: 'Jar', sizeM: [.1, .2, .1], asset: {path: 'assets/jar.glb', format: 'glb'}, sourceUrl: 'https://polyhaven.com/a/jar'};
    for (const scene of scenes) {addProp(scene, 'box'); addPropFromLibrary(scene, entry);}
    expect(scenes[0].environment.props).toEqual(scenes[1].environment.props);
    expect(scenes[0].environment.props[0].sizeM).toEqual([.32 * .35, .32 * .35, .32 * .35]);
    expect(scenes[0].environment.props[1].sizeM).toEqual(entry.sizeM);
    expect(scenes[0].environment.props[1].translationM[0]).toBeCloseTo(.32 * .65 + .05);
  });
  it('adds typed lights with unique ids, switches types additively and removes down to one light', () => {
    const scene: any = structuredClone(fixture);
    expect(addLight(scene, 'spot')).toBe('spot-1'); expect(addLight(scene, 'spot')).toBe('spot-2'); expect(addLight(scene, 'area')).toBe('area-1');
    const lights = scene.lighting.lights, spot = lights.find((light: any) => light.id === 'spot-1');
    expect(spot).toMatchObject({type: 'spot', coneDeg: 35, blend: .4, name: 'Spot', enabled: true});
    expect(lights.find((light: any) => light.id === 'spot-2').name).toBe('Spot 2');
    const area = lights.find((light: any) => light.id === 'area-1');
    expect(area.type).toBeUndefined(); expect(area.coneDeg).toBeUndefined(); expect(area.name).toBe('Area');
    setLightType(area, 'spot'); expect(area).toMatchObject({type: 'spot', coneDeg: 40, blend: .3});
    area.coneDeg = 20; setLightType(area, 'spot'); expect(area.coneDeg).toBe(20);
    setLightType(area, 'area'); expect('type' in area).toBe(false); expect('coneDeg' in area).toBe(false); expect('blend' in area).toBe(false);
    for (const id of ['spot-1', 'spot-2', 'area-1', 'fill', 'rim']) removeLight(scene, id);
    expect(scene.lighting.lights.map((light: any) => light.id)).toEqual(['key']);
    expect(() => removeLight(scene, 'key')).toThrow('at least one light');
    scene.lighting.hdri = {name: 'x'}; removeLight(scene, 'key'); expect(scene.lighting.lights).toEqual([]);
    expect(() => {for (let count = 0; count < 9; count++) addLight(scene, 'spot');}).toThrow('eight');
    expect(scene.lighting.lights).toHaveLength(8);
  });
  it('the dramatic preset keeps the HDRI and places one hard warm spot above the product', () => {
    const scene: any = structuredClone(fixture); const scale = .137 / .12;
    scene.lighting = {...defaultLighting(scene), hdri: {name: 'x'}};
    applyDramaticSpot(scene);
    expect(scene.lighting.ambientStrength).toBe(.15); expect(scene.lighting.ambientColor).toEqual([.24, .18, .16]); expect(scene.lighting.hdri).toEqual({name: 'x'});
    expect(scene.lighting.lights).toHaveLength(1);
    const spot = scene.lighting.lights[0];
    expect(spot).toMatchObject({id: 'spot', type: 'spot', coneDeg: 35, blend: .4, color: [1, .86, .70], enabled: true});
    expect(spot.positionM[1]).toBeCloseTo(.42 * scale); expect(spot.positionM[2]).toBeCloseTo(.28 * scale);
    expect(spot.targetM).toEqual([0, .137 * .45, 0]);
    expect(spot.powerW).toBeCloseTo(14 * scale * scale, 3); expect(spot.diameterM).toBeCloseTo(.05 * scale);
    expect(lightTarget('spot')).toBe('$light:spot'); expect(isLightTarget('$light:spot')).toBe(true); expect(isLightTarget('$product')).toBe(false); expect(lightIdFromTarget('$light:spot')).toBe('spot');
  });
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
