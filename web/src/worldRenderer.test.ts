import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {StudioViewport} from './viewport';
import {defaultLighting} from './world';

function studio(scene: any, options = {studioMode: true, capture: false}) {
  // Build the real geometry and lights; only the WebGL host is unnecessary here.
  const view = Object.create(StudioViewport.prototype) as any;
  view.content = new THREE.Group();
  view.scene = new THREE.Scene();
  view.scene.add(view.content);
  view.options = options;
  view.disposed = false;
  view.canvas = {style: {}};
  view.controls = null;
  view.environmentObjects = new Map<THREE.Object3D, boolean>();
  view.environmentBackground = view.color(scene.environment.worldColor);
  view.scene.background = view.environmentBackground;
  view.productPreview = false;
  view.productGround = null;
  view.spark = null;
  view.invalidate = vi.fn();
  view.makeStudio(scene);
  return view;
}

describe('world geometry and lighting renderer contract', () => {
  it('keeps a fixed studio and shadow budget across differently scaled source products', () => {
    const sources = [1, 1000].map(factor => {
      const scene: any = structuredClone(fixture);
      scene.product.dimensionsM = [.32, .16, .24].map(value => value * factor);
      scene.placement.scale = 1 / factor;
      if (factor === 1000) scene.placement.translationM = [4, 5, -1.28];
      scene.environment.studioSizeM = .32;
      scene.environment.plinth.translationM = [.1, .2, .3];
      return scene;
    });
    const before = structuredClone(sources), views = sources.map(scene => studio(scene));
    try {
      const snapshot = (view: any) => {
        const sweep = [...view.environmentObjects.keys()].find((object: any) => object instanceof THREE.Mesh && object.name !== 'Explicit contact plinth') as THREE.Mesh;
        const ground = view.productGround as THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
        const shader: any = {uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <tonemapping_fragment>'};
        ground.material.onBeforeCompile(shader, null!);
        const lights = view.content.children.filter((object: THREE.Object3D) => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight[];
        return {sweep: Array.from(sweep.geometry.getAttribute('position').array),
          span: ground.geometry.parameters.width, contact: shader.uniforms.contactRadius.value,
          contactCenter: shader.uniforms.contactCenter.value.toArray(),
          lights: lights.map(light => ({position: light.position.toArray(), target: light.target.position.toArray(),
            left: light.shadow.camera.left, far: light.shadow.camera.far, bias: light.shadow.normalBias}))};
      };
      expect(snapshot(views[1])).toEqual(snapshot(views[0]));
      expect(snapshot(views[0]).span).toBe(32);
      expect(snapshot(views[0]).contact).toBeCloseTo(.32 * .9);
      expect(snapshot(views[0]).contactCenter).toEqual([.1, .3]);
      expect(snapshot(views[0]).lights[0].target).toEqual([.1, .2 + .07 / 2 + .32 * .52, .3]);
      expect(sources).toEqual(before);
    } finally {views.forEach(view => view.disposeObject(view.content));}
  });

  it('keeps fixed-stage shadow coverage when editing the light rig', () => {
    const sources = [1, 1000].map(factor => {
      const scene: any = structuredClone(fixture);
      scene.environment.studioSizeM = .32;
      scene.product.dimensionsM = [.32, .16, .24].map(value => value * factor);
      scene.lighting = defaultLighting(scene);
      return scene;
    });
    const views = sources.map(scene => studio(scene));
    try {
      const coverage = (view: any) => view.content.children.filter((object: THREE.Object3D) => object instanceof THREE.DirectionalLight)
        .map((light: THREE.DirectionalLight) => [light.shadow.camera.left, light.shadow.camera.right, light.shadow.camera.far, light.shadow.normalBias]);
      expect(coverage(views[0])).toEqual(coverage(views[1]));
    } finally {views.forEach(view => view.disposeObject(view.content));}
  });

  it('retains the exact legacy live rig for documents without explicit lighting', () => {
    const scene = structuredClone(fixture); const before = JSON.stringify(scene);
    const view = studio(scene); const scale = .137 / .12;
    const lights = view.content.children.filter((node: any) => node instanceof THREE.Light);
    expect(lights).toHaveLength(4);
    expect(lights[0]).toBeInstanceOf(THREE.HemisphereLight);
    expect(lights[0].intensity).toBe(1.2);
    expect(lights[0].color.getHex()).toBe(0xf3f1e8);
    expect(lights.slice(1).map((light: any) => light.intensity)).toEqual([2.4, .9, 3]);
    expect(lights[1].position.toArray()).toEqual([-.19 * scale, .32 * scale, .24 * scale]);
    expect(lights[1].target.position.toArray()).toEqual([0, .137 * .52, 0]);
    expect(view.productGround.geometry.parameters.width).toBe(.137 * 100);
    expect(lights.every((light: any) => !(light instanceof THREE.RectAreaLight))).toBe(true);
    expect(JSON.stringify(scene)).toBe(before);
    view.disposeObject(view.content);
  });

  it('renders edited position, color, diameter, power, ambient and enabled state', () => {
    const scene: any = structuredClone(fixture); scene.lighting = defaultLighting(scene);
    const key = scene.lighting.lights[0];
    Object.assign(key, {positionM: [.8, .5, -.4], targetM: [.1, .2, .3], color: [.2, .4, .6], powerW: 12, diameterM: .4});
    scene.lighting.lights[1].enabled = false;
    scene.lighting.lights[2].powerW = 0;
    scene.lighting.ambientStrength = .9;
    const view = studio(scene);
    const areas = view.content.children.filter((node: any) => node instanceof THREE.RectAreaLight);
    expect(areas).toHaveLength(1);
    const area = areas[0];
    expect(area.name).toBe('Studio / Key');
    expect(area.position.toArray()).toEqual(key.positionM);
    expect(area.color.toArray()).toEqual(key.color);
    expect(area.width * area.height).toBeCloseTo(Math.PI * (.4 / 2) ** 2);
    expect(area.intensity).toBeCloseTo(12 / (Math.PI * area.width * area.height));
    const emitterNormal = new THREE.Vector3(0, 0, -1).applyQuaternion(area.quaternion);
    const towardTarget = new THREE.Vector3().fromArray(key.targetM).sub(area.position).normalize();
    expect(emitterNormal.dot(towardTarget)).toBeCloseTo(1);
    const ambient = view.content.children.find((node: any) => node instanceof THREE.HemisphereLight);
    expect(ambient.intensity).toBeCloseTo(2.4);
    const shadow = view.content.children.find((node: any) => node instanceof THREE.DirectionalLight);
    expect(shadow.position.toArray()).toEqual(key.positionM);
    expect(shadow.target.position.toArray()).toEqual(key.targetM);
    const dispose = vi.spyOn(shadow.shadow, 'dispose');
    view.disposeObject(view.content);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([undefined, true])('keeps the plinth visible when visibility is %s', visible => {
    const scene: any = structuredClone(fixture); scene.environment.plinth.visible = visible;
    const view = studio(scene), ledge = view.content.getObjectByName('Explicit contact plinth');
    expect(ledge.visible).toBe(true); expect(view.environmentObjects.get(ledge)).toBe(true);
    view.disposeObject(view.content);
  });

  it.each([undefined, true, false])('anchors the authored sweep to the contact plane when plinth visibility is %s', visible => {
    const scene: any = structuredClone(fixture);
    scene.environment.props = [];
    Object.assign(scene.environment.plinth, {visible, translationM: [.1, .2, .3], sizeM: [.3, .12, .4]});
    const before = structuredClone(scene), view = studio(scene);
    const sweep = [...view.environmentObjects.keys()].find((object: any) => object instanceof THREE.Mesh && object.name !== 'Explicit contact plinth') as THREE.Mesh;
    sweep.geometry.computeBoundingBox();
    const bottom = sweep.geometry.boundingBox!.min.y;
    expect(bottom).toBeCloseTo((visible === false ? .26 : .14) - .0001, 7);
    if (visible === false) expect(bottom).toBeCloseTo(view.productGround.position.y, 7);
    expect(scene).toEqual(before);
    view.disposeObject(view.content);
  });

  it.each(['mesh', 'splat'])('does not add an authored sweep over a %s world with hidden support', kind => {
    const scene: any = structuredClone(fixture);
    scene.environment.kind = kind; scene.environment.props = []; scene.environment.plinth.visible = false;
    const view = studio(scene);
    expect([...view.environmentObjects.keys()]).toEqual([view.content.getObjectByName('Explicit contact plinth')]);
    view.disposeObject(view.content);
  });

  it('hides only the declared plinth while retaining contact coordinates and preview restoration', () => {
    const scene: any = structuredClone(fixture); scene.environment.plinth.visible = false;
    scene.environment.props = [{ id: 'visible-prop', shape: 'box', sizeM: [.03, .04, .05], bevelM: 0,
      translationM: [.2, .02, 0], rotationXyzw: [0, 0, 0, 1],
      material: {baseColor: [.2, .3, .4, 1], roughness: .7, metallic: .1} }];
    const before = JSON.stringify(scene), view = studio(scene);
    const ledge = view.content.getObjectByName('Explicit contact plinth'), prop = view.content.getObjectByName('visible-prop');
    expect(ledge.visible).toBe(false); expect(prop.visible).toBe(true);
    expect(ledge.position.toArray()).toEqual(scene.environment.plinth.translationM);
    expect(view.productGround.position.y).toBeCloseTo(scene.environment.plinth.translationM[1] + scene.environment.plinth.sizeM[1] / 2 - .0001);
    view.setProductPreview(true); expect(view.productGround.visible).toBe(true); expect(ledge.visible).toBe(false);
    view.setProductPreview(false); expect(ledge.visible).toBe(false); expect(prop.visible).toBe(true);
    expect(JSON.stringify(scene)).toBe(before);
    const capture = studio(scene, {studioMode: true, capture: true});
    expect(capture.content.getObjectByName('Explicit contact plinth').visible).toBe(false);
    expect(capture.content.getObjectByName('visible-prop').visible).toBe(true);
    view.disposeObject(view.content); capture.disposeObject(capture.content);
  });

  it('uses declared linear plinth material and bounds very small support bevels', () => {
    const scene: any = structuredClone(fixture);
    const plinth = scene.environment.plinth;
    plinth.translationM = [.2, .3, .4]; plinth.sizeM = [.001, .001, .001];
    plinth.material = {baseColor: [.15, .25, .35, 1], roughness: .73, metallic: .2};
    const view = studio(scene); const mesh = view.content.getObjectByName('Explicit contact plinth');
    expect(mesh.position.toArray()).toEqual(plinth.translationM);
    expect(mesh.material.color.toArray()).toEqual([.15, .25, .35]);
    expect(mesh.material.roughness).toBe(.73); expect(mesh.material.metalness).toBe(.2);
    mesh.geometry.computeBoundingBox();
    const dimensions = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    for (const value of dimensions.toArray()) expect(value).toBeCloseTo(.001, 8);
    view.disposeObject(view.content);
  });
});


describe('Product white preview', () => {
  it('isolates real environment geometry and restores it without changing lights or materials', () => {
    const scene: any = structuredClone(fixture);
    scene.lighting = defaultLighting(scene);
    scene.environment.props = [{
      id: 'test-prop', shape: 'box', sizeM: [.03, .04, .05], bevelM: .001,
      translationM: [.2, .02, 0], rotationXyzw: [0, 0, 0, 1],
      material: {baseColor: [.2, .3, .4, 1], roughness: .7, metallic: .1},
    }];
    const before = JSON.stringify(scene);
    const view = studio(scene);
    const background = view.scene.background;
    const environment = [...view.environmentObjects.keys()] as THREE.Object3D[];
    expect(environment).toContain(view.content.getObjectByName('Explicit contact plinth'));
    expect(environment).toContain(view.content.getObjectByName('test-prop'));
    expect(environment).toHaveLength(3); // plinth, prop, authored sweep
    const ground = view.content.getObjectByName('Product contact shadow') as THREE.Mesh;
    expect(ground).toBe(view.productGround);
    expect(ground.material).toBeInstanceOf(THREE.ShadowMaterial);
    expect(ground.receiveShadow).toBe(true);
    expect(ground.visible).toBe(false);
    expect(ground.position.y).toBeCloseTo(scene.environment.plinth.translationM[1] + scene.environment.plinth.sizeM[1] / 2 - .0001);
    const lights = view.content.children.filter((node: any) => node instanceof THREE.Light);
    const lighting = lights.map((node: any) => ({node, intensity: node.intensity, color: node.color.toArray(), visible: node.visible}));
    const material = view.surface(scene.product.components[0].material);
    const product = new THREE.Mesh(new THREE.BoxGeometry(.01, .02, .03), material);
    product.castShadow = true;
    view.content.add(product);
    const materialBefore = {color: material.color.toArray(), opacity: material.opacity, transparent: material.transparent};

    view.setProductPreview(true);
    expect(view.scene.background.getHex()).toBe(0xffffff);
    expect(environment.every(node => !node.visible)).toBe(true);
    expect(ground.visible).toBe(true);
    expect(product.visible).toBe(true);
    expect(product.material).toBe(material);
    expect(product.castShadow).toBe(true);
    expect({color: material.color.toArray(), opacity: material.opacity, transparent: material.transparent}).toEqual(materialBefore);
    for (const item of lighting) {
      expect(item.node.parent).toBe(view.content);
      expect(item.node.intensity).toBe(item.intensity);
      expect(item.node.color.toArray()).toEqual(item.color);
      expect(item.node.visible).toBe(item.visible);
    }

    view.setProductPreview(false);
    expect(view.scene.background).toEqual(background);
    expect(environment.every(node => node.visible)).toBe(true);
    expect(ground.visible).toBe(false);
    expect(product.material).toBe(material);
    expect(JSON.stringify(scene)).toBe(before);
    view.disposeObject(view.content);
  });

  it('restores preexisting hidden roots and switches the splat renderer with the preview', () => {
    const view = studio(structuredClone(fixture));
    const hidden = new THREE.Group(); hidden.visible = false;
    const imported = new THREE.Group();
    view.content.add(hidden, imported);
    view.environmentObjects.set(hidden, false);
    view.environmentObjects.set(imported, true);
    view.spark = new THREE.Object3D();
    view.setProductPreview(true);
    expect(hidden.visible).toBe(false);
    expect(imported.visible).toBe(false);
    expect(view.spark.visible).toBe(false);
    view.setProductPreview(false);
    expect(hidden.visible).toBe(false);
    expect(imported.visible).toBe(true);
    expect(imported.parent).toBe(view.content); // calibration keeps its alignment root
    expect(view.spark.visible).toBe(true);
    view.disposeObject(view.content);
  });

  it.each([
    {studioMode: true, capture: true},
    {studioMode: false, capture: false},
  ])('does not change capture or nonstudio viewports: %j', options => {
    const view = studio(structuredClone(fixture), options);
    const background = view.scene.background;
    const visibility = view.content.children.map((node: THREE.Object3D) => node.visible);
    expect(view.productGround).toBeNull();
    view.setProductPreview(true);
    expect(view.productPreview).toBe(false);
    expect(view.scene.background).toBe(background);
    expect(view.content.children.map((node: THREE.Object3D) => node.visible)).toEqual(visibility);
    expect(view.invalidate).not.toHaveBeenCalled();
    view.disposeObject(view.content);
  });
});
