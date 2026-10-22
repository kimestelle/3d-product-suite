import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {MathUtils, Matrix4, PerspectiveCamera, Vector3} from 'three';
import fixture from '../../examples/bottle.scene.json';
import {filmCameraPoseAtFrame} from './filmMotion';
import {isRandomCameraPoseSafe, MAX_RANDOM_ORBIT_DEGREES, MAX_RANDOM_PUSH_FRACTION, productBounds, projectedProductBounds, randomCameraPose, RANDOM_DETAIL_OCCUPANCY, RANDOM_FULL_FRAME_INSET} from './randomSetupFraming';

const source = (): any => structuredClone(fixture);
const aspects = [[1920, 1080], [1080, 1920], [1080, 1080], [1080, 1350]];
const radius = (pose: {positionM: number[]; targetM: number[]}) => new Vector3().fromArray(pose.positionM).distanceTo(new Vector3().fromArray(pose.targetM));
// Bounds fixtures exercise real lamp dimensions and unusually wide/deep imports;
// they do not pretend to be the private Nessino mesh or an evaluated animation.
function boxFixture(size: number[]) {
  const scene = source();
  scene.product.components = [{id: 'imported-product', sizeM: size, assembly: {translationM: [0, size[1] / 2, 0], rotationXyzw: [0, 0, 0, 1], scale: 1}}];
  scene.product.dimensionsM = size;
  return scene;
}

describe('random shot camera framing', () => {
  it.each(aspects)('fits the complete source assembly throughout a 32° orbit or 20%% push at %i×%i', (width, height) => {
    for (const scene of [source(), boxFixture([.32, .223003, .32]), boxFixture([.8, .08, .12]), boxFixture([.06, .13, .4])]) {
      Object.assign(scene.render, {width, height}); scene.motions = [];
      const bounds = productBounds(scene), aspect = width / height;
      for (const view of ['front', 'three-quarter'] as const) {
        const pose = randomCameraPose(scene, view);
        for (const [kind, amount] of [['orbit', MAX_RANDOM_ORBIT_DEGREES], ['orbit', -MAX_RANDOM_ORBIT_DEGREES], ['dolly', radius(pose) * MAX_RANDOM_PUSH_FRACTION]] as const) {
          const shot = {...scene.shots[0], startFrame: 1, endFrame: 97, camera: {from: pose, to: structuredClone(pose)},
            motions: [{id: 'framing-check', target: '$camera', kind, axis: 'y', amount, enabled: true, startFrame: 1, durationFrames: 97, easing: 'ease'}]};
          for (let frame = 1; frame <= 97; frame++) {
            const sampled = filmCameraPoseAtFrame(scene, shot, frame), projected = projectedProductBounds(bounds, sampled, aspect);
            expect(Math.max(Math.abs(projected.left), Math.abs(projected.right), Math.abs(projected.top), Math.abs(projected.bottom))).toBeLessThanOrEqual(RANDOM_FULL_FRAME_INSET + 1e-9);
            expect(isRandomCameraPoseSafe(bounds, sampled, aspect, shot.camera)).toBe(true);
          }
        }
      }
    }
  });

  it.each(aspects)('makes a measurable close-up across product scales at %i×%i', (width, height) => {
    for (const scale of [.01, 1, 10]) {
      const scene = source(); Object.assign(scene.render, {width, height}); scene.placement.scale = scale;
      const bounds = productBounds(scene), pose = randomCameraPose(scene, 'detail');
      const projected = projectedProductBounds(bounds, pose, width / height);
      expect(projected.occupancy).toBeCloseTo(RANDOM_DETAIL_OCCUPANCY, 8);
      expect(projected.minDepth).toBeGreaterThan(.001);
      expect(projected.occupancy).toBeGreaterThan(projectedProductBounds(bounds, randomCameraPose(scene, 'front'), width / height).occupancy * 1.8);
      if (scale === .01) expect(radius(pose)).toBeLessThan(.01);
    }
  });

  it('uses the same vertical sensor and projection as the production Three camera', () => {
    const scene = source(), bounds = productBounds(scene), pose = randomCameraPose(scene, 'three-quarter'), aspect = scene.render.width / scene.render.height;
    const camera = new PerspectiveCamera(MathUtils.radToDeg(2 * Math.atan(18 / pose.focalLengthMm)), aspect, .001, 100);
    camera.position.fromArray(pose.positionM); camera.lookAt(new Vector3().fromArray(pose.targetM)); camera.updateMatrixWorld();
    const points = Array.from({length: 8}, (_, index) => new Vector3(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z).project(camera));
    const projected = projectedProductBounds(bounds, pose, aspect);
    expect(projected.left).toBeCloseTo(Math.min(...points.map(point => point.x)), 12);
    expect(projected.right).toBeCloseTo(Math.max(...points.map(point => point.x)), 12);
    expect(projected.bottom).toBeCloseTo(Math.min(...points.map(point => point.y)), 12);
    expect(projected.top).toBeCloseTo(Math.max(...points.map(point => point.y)), 12);
  });

  it('includes component rotation/scales and placement, omits removed components, and does not mutate the scene', () => {
    const scene = boxFixture([.2, .4, .1]), part = scene.product.components[0];
    part.assembly.rotationXyzw = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; part.assembly.scale = 2;
    scene.placement.scale = .5; scene.placement.translationM = [2, 3, 4];
    scene.product.components.push({...structuredClone(part), id: 'removed', sizeM: [100, 100, 100]}); scene.product.removedPartIds = ['removed'];
    const before = structuredClone(scene), bounds = productBounds(scene), size = bounds.getSize(new Vector3());
    [.1, .4, .2].forEach((value, index) => expect(size.getComponent(index)).toBeCloseTo(value, 12));
    randomCameraPose(scene, 'front'); randomCameraPose(scene, 'detail');
    expect(scene).toEqual(before);
    scene.product.removedPartIds.push(part.id);
    expect(() => productBounds(scene)).toThrow('at least one visible product part');
  });

  it('keeps autofocus beyond the lens and explains impossible small-product close-ups', () => {
    const scene = source(), camera = {depthOfField: {enabled: true, fStop: 2.8}};
    const pose = randomCameraPose(scene, 'detail', camera), aspect = scene.render.width / scene.render.height;
    expect(radius(pose)).toBeGreaterThan(pose.focalLengthMm / 1000);
    expect(isRandomCameraPoseSafe(productBounds(scene), pose, aspect, camera)).toBe(true);
    scene.placement.scale = .01;
    expect(() => randomCameraPose(scene, 'detail', camera)).toThrow('too small for a close-up');
    expect(() => randomCameraPose(source(), 'detail', {depthOfField: {...camera.depthOfField, focusDistanceM: .03}})).toThrow('beyond the lens focal length');
  });

  it('matches canonical source-node transforms and ignores deleted imported meshes without reading their assets', () => {
    const scene = boxFixture([.2, .2, .2]), part = scene.product.components[0];
    scene.actions = []; scene.animation = {tracks: []}; scene.motions = []; scene.shots.forEach((shot: any) => {shot.motions = [];});
    scene.placement.translationM = [.5, .2, -.4]; scene.placement.scale = .4;
    part.assembly.scale = 1.5; part.assembly.rotationXyzw = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    part.sourceNodes = [
      {nodeIndex: 0, parentIndex: null, name: 'group', hasMesh: false, drawable: true, localMatrix: new Matrix4().makeTranslation(.02, .03, .04).toArray(), boundsM: [[-10, -10, -10], [10, 10, 10]]},
      {nodeIndex: 1, parentIndex: 0, name: 'kept', hasMesh: true, drawable: true, localMatrix: new Matrix4().makeTranslation(.1, .02, 0).toArray(), boundsM: [[-.01, -.05, -.02], [.01, .05, .02]]},
      {nodeIndex: 2, parentIndex: 0, name: 'removed', hasMesh: true, drawable: true, localMatrix: new Matrix4().toArray(), boundsM: [[-10, -10, -10], [10, 10, 10]]},
    ];
    part.partTransforms = {
      '0': {translationM: [.8, 0, 0], rotationXyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: 1.3, pivotM: [.04, 0, .06]},
      '1': {translationM: [0, .3, 0], rotationXyzw: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: .7},
    };
    scene.product.removedPartIds = [`${part.id}::node:2`];
    const expected = JSON.parse(execFileSync('python3', ['-c', [
      'import json,sys,itertools',
      'from film.scene import evaluate',
      'from film.part_motion import point',
      's=json.load(sys.stdin); sample=evaluate(s,1); points=[]',
      'for c in s["product"]["components"]:',
      ' for n in c.get("sourceNodes",[]):',
      '  id=f"{c[\'id\']}::node:{n[\'nodeIndex\']}"',
      '  if n["hasMesh"] and id not in sample.get("removedPartIds",[]):',
      '   points.extend(point(sample["parts"][id]["worldMatrix"],p) for p in itertools.product(*zip(*n["boundsM"])))',
      'print(json.dumps([[min(p[i] for p in points) for i in range(3)],[max(p[i] for p in points) for i in range(3)]]))',
    ].join('\n')], {cwd: fileURLToPath(new URL('../..', import.meta.url)), input: JSON.stringify(scene), encoding: 'utf8'}));
    const bounds = productBounds(scene);
    [bounds.min, bounds.max].forEach((point, bound) => point.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expected[bound][axis], 12)));
    expect(bounds.getSize(new Vector3()).length()).toBeLessThan(.1);
    expect(isRandomCameraPoseSafe(bounds, randomCameraPose(scene, 'front'), scene.render.width / scene.render.height)).toBe(true);
  });

  it('rejects a push that reaches the product near face even while its target is still ahead', () => {
    const scene = boxFixture([.1, .1, .8]), bounds = productBounds(scene), pose = randomCameraPose(scene, 'detail'), aspect = scene.render.width / scene.render.height;
    const target = new Vector3().fromArray(pose.targetM), offset = new Vector3().fromArray(pose.positionM).sub(target);
    pose.positionM = target.addScaledVector(offset, .1).toArray();
    expect(radius(pose)).toBeGreaterThan(.00001);
    expect(isRandomCameraPoseSafe(bounds, pose, aspect)).toBe(false);
  });
});
