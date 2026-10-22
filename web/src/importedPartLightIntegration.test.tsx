import * as THREE from 'three';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {availableMotionKinds, listMotions, validateFilmMotions} from './filmMotion';
import {createFrameSetup, frameObjectMotionKinds, setFrameObjects} from './frameSetup';
import {FrameSetupObjects, nextFrameTargets, type FrameSetupProps} from './NewFrameFlow';
import {StudioViewport} from './viewport';

const target = 'cap::node:3';
function source() {
  const scene: any = structuredClone(fixture);
  scene.product.components.find((part: any) => part.id === 'cap').sourceNodes = [{
    nodeIndex: 3, parentIndex: null, name: 'Cap shell', drawable: true, hasMesh: true,
    localMatrix: new THREE.Matrix4().toArray(), boundsM: [[-.01, 0, -.01], [.01, .02, .01]],
  }];
  return scene;
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('imported parts with the animated light rig', () => {
  it('keeps imported mesh targets and lights in the same new-scene workflow', () => {
    const scene = source();
    let setup = createFrameSetup(scene, scene.shots[0].id);
    expect(availableMotionKinds(scene, target)).toEqual(['move', 'rotate', 'scale']);
    expect(frameObjectMotionKinds(scene, [target, '$light:key'])).toEqual(['move']);
    expect(nextFrameTargets(['$product', '$light:key'], target, true)).toEqual([target, '$light:key']);
    setup = setFrameObjects(scene, setup, [target, '$light:key'], 'move');
    expect(listMotions(scene, setup.shotId).map(({motion}) => motion.target)).toEqual([target, '$light:key']);
    expect(scene.lighting.lights[0].id).toBe('key');
    expect(() => validateFilmMotions(scene)).not.toThrow();
    expect(() => setFrameObjects(scene, setup, [target, '$product'], 'move')).toThrow('not both');

    const noop = () => {};
    const props: FrameSetupProps = {scene, setup, onTargets: noop, onObjectKind: noop, onCameraTarget: noop,
      onCameraKind: noop, onPatchMotion: noop, onStage: noop, onComplete: noop, onDiscard: noop};
    const objects = renderToStaticMarkup(<FrameSetupObjects {...props}/>);
    expect(objects).toContain('aria-label="Animate Cap shell"');
    expect(objects).toContain('aria-label="Animate Key"');
    const camera = renderToStaticMarkup(<FrameSetupObjects {...props} setup={{...setup, stage: 'camera'}}/>);
    expect(camera).toContain('aria-label="Aim at Cap shell"');
    expect(camera).not.toContain('aria-label="Aim at Key"');
  });

  it('applies exact source matrices and light positions from one sampled frame', async () => {
    const view = Object.create(StudioViewport.prototype) as any;
    const mesh = new THREE.Mesh(), component = new THREE.Group();
    const light = new THREE.SpotLight(), aim = new THREE.Object3D();
    Object.assign(view, {options: {}, disposed: false, loadVersion: 1, frameRequest: 0,
      frameQueue: Promise.resolve(), camera: new THREE.PerspectiveCamera(),
      components: new Map([['cap', component]]), parts: new Map([[target, mesh]]),
      studioLights: new Map([['key', {light, target: aim, shadow: null}]]),
      filmClip: {kind: 'scene'}, visible: false});
    vi.spyOn(view, 'updateUvProbeScale').mockImplementation(() => {});
    vi.stubGlobal('document', {hidden: false});
    const localMatrix = new THREE.Matrix4().set(1, .2, 0, .03, 0, 1, 0, .04, 0, 0, 1, .05, 0, 0, 0, 1).toArray();
    await view.frame({components: {cap: {translationM: [0, .02, 0], rotationXyzw: [0, 0, 0, 1]}},
      parts: {[target]: {localMatrix}}, lights: [{id: 'key', positionM: [.2, .3, .4], targetM: [0, .02, 0]}],
      camera: {positionM: [.3, .3, .3], targetM: [0, .05, 0], focalLengthMm: 50}});
    expect(mesh.matrix.toArray()).toEqual(localMatrix);
    expect(mesh.matrixAutoUpdate).toBe(false);
    expect(component.position.toArray()).toEqual([0, .02, 0]);
    expect(light.position.toArray()).toEqual([.2, .3, .4]);
    expect(aim.position.toArray()).toEqual([0, .02, 0]);
  });
});
