import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {StudioViewport} from './viewport';

function viewport() {
  // Build the studio without a WebGL context; only the rig and content graph are exercised.
  const view = Object.create(StudioViewport.prototype) as any;
  Object.assign(view, {canvas: {style: {}}, scene: new THREE.Scene(), content: new THREE.Group(), components: new Map(), loadVersion: 1, disposed: false,
    camera: new THREE.PerspectiveCamera(), options: {}, parts: new Map(), originalVisibility: new Map(), environmentObjects: new Map(),
    productGround: null, productPreview: false, studioLights: new Map(), previewMaterials: new Set(), focusMaterials: new Map()});
  vi.spyOn(view, 'scheduleRender').mockImplementation(() => {});
  return view;
}

function studio(lights: any[], extra: any = {}) {
  return {placement: {translationM: [0, 0, 0]}, product: {dimensionsM: [.1, .1, .1], components: []},
    environment: {kind: 'authored', worldColor: [.1, .1, .1], plinth: {id: 'plinth', sizeM: [.3, .02, .3], translationM: [0, -.01, 0]}, props: []},
    lighting: {ambientStrength: .15, lights, ...extra}};
}

describe('studio spot lights', () => {
  it('builds a shadow-casting spot aimed at its target, tints ambient and moves lights from sampled poses', () => {
    const view = viewport();
    const spot = {id: 'spot', name: 'Spot', type: 'spot', enabled: true, positionM: [-.1, .42, .28], targetM: [0, .05, 0], powerW: 14, diameterM: .05, color: [1, .86, .7], coneDeg: 35, blend: .4};
    const key = {id: 'key', name: 'Key', enabled: true, positionM: [.2, .3, .2], targetM: [0, .05, 0], powerW: 2.6, diameterM: .23, color: [1, 1, 1]};
    view.makeStudio(studio([spot, key], {ambientColor: [.3, .2, .2]}));
    const light = view.content.children.find((child: any) => child.isSpotLight) as THREE.SpotLight;
    expect(light.name).toBe('Studio / Spot');
    expect(light.castShadow).toBe(true);
    expect(light.angle).toBeCloseTo(THREE.MathUtils.degToRad(17.5));
    expect(light.penumbra).toBe(.4); expect(light.decay).toBe(2); expect(light.distance).toBe(0);
    // Watts read as lumens: SpotLight.power convention, candela = lumens / 4π.
    expect(light.intensity).toBeCloseTo(14 / (4 * Math.PI));
    expect(light.shadow.mapSize.x).toBe(2048); expect(light.shadow.bias).toBe(-.0002);
    expect(light.shadow.camera.near).toBeGreaterThan(0); expect(light.shadow.camera.far).toBeGreaterThan(light.shadow.camera.near);
    expect(light.target.position.toArray()).toEqual([0, .05, 0]);
    expect(view.content.children).toContain(light.target);
    const hemisphere = view.content.children.find((child: any) => child.isHemisphereLight) as THREE.HemisphereLight;
    expect(hemisphere.color.r).toBeCloseTo(.3); expect(hemisphere.intensity).toBeCloseTo(.15 * 1.2 / .45);
    expect(view.content.children.filter((child: any) => child.isRectAreaLight)).toHaveLength(1);
    expect([...view.studioLights.keys()]).toEqual(['spot', 'key']);
    view.applyLightPoses([{id: 'spot', positionM: [.3, .42, 0], targetM: [0, .1, 0]}, {id: 'key', positionM: [0, .3, .3], targetM: [0, .06, 0]}, {id: 'ghost', positionM: [0, 0, 0], targetM: [0, 1, 0]}]);
    expect(light.position.toArray()).toEqual([.3, .42, 0]); expect(light.target.position.toArray()).toEqual([0, .1, 0]);
    const area = view.studioLights.get('key');
    expect(area.light.position.toArray()).toEqual([0, .3, .3]);
    expect(area.shadow.position.toArray()).toEqual([0, .3, .3]); expect(area.shadow.target.position.toArray()).toEqual([0, .06, 0]);
  });

  it('keeps the world colour for the hemisphere and no spot when the rig has only area lights', () => {
    const view = viewport();
    view.makeStudio(studio([{id: 'key', name: 'Key', enabled: true, positionM: [.2, .3, .2], targetM: [0, .05, 0], powerW: 2.6, diameterM: .23, color: [1, 1, 1]}]));
    const hemisphere = view.content.children.find((child: any) => child.isHemisphereLight) as THREE.HemisphereLight;
    expect(hemisphere.color.r).toBeCloseTo(.1);
    expect(view.content.children.some((child: any) => child.isSpotLight)).toBe(false);
    view.applyLightPoses([]);
  });
});
