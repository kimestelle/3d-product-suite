import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { demoApi, evaluateDemoScene, type DemoBundle } from './demo';

vi.mock('./runtime', () => ({ demoDataUrl: (filename = 'bootstrap.json') => '/repository/demo/' + filename }));

let directory: string, bundle: DemoBundle, changed: any, golden: any, sampledBundle: DemoBundle;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'gesso-demo-test-'));
  // Generate fresh test fixtures rather than relying on ignored public output.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync('python3', ['-c', [
    'from pathlib import Path',
    'from copy import deepcopy',
    'import json,sys',
    'from scripts.build_static_demo import build_demo',
    'from film.scene import sample_scene',
    'out=Path(sys.argv[1]); b=build_demo(out)',
    'scene=deepcopy(b["project"]["scene"])',
    'scene["actions"][0].update(startSeconds=1.25,durationSeconds=2.5)',
    'scene["shots"][0]["camera"]["from"].update(positionM=[.21,.18,.43],focalLengthMm=67)',
    'scene["shots"][0]["camera"]["to"].update(positionM=[.11,.14,.31],targetM=[.015,.08,0],focalLengthMm=43)',
    '(out/"changed.json").write_text(json.dumps(sample_scene(scene)))',
    'scene=deepcopy(b["project"]["scene"])',
    'scene["placement"]["scale"]=.37',
    'scene["shots"][0]["motions"]=[{"id":"test-orbit","target":"$camera","kind":"orbit","axis":"y","amount":38,"startFrame":1,"durationFrames":120,"easing":"ease","enabled":True}]',
    '(out/"sampled.json").write_text(json.dumps(sample_scene(scene)))',
  ].join('\n'), directory], { cwd: root });
  bundle = { bootstrap: JSON.parse(readFileSync(join(directory, 'bootstrap.json'), 'utf8')),
    samples: JSON.parse(readFileSync(join(directory, 'samples.json'), 'utf8')) };
  golden = JSON.parse(readFileSync(join(directory, 'changed.json'), 'utf8'));
  changed = golden.scene;
  const sampled = JSON.parse(readFileSync(join(directory, 'sampled.json'), 'utf8'));
  sampledBundle = clone(bundle);
  sampledBundle.bootstrap.demo.playbackMode = 'sampled';
  sampledBundle.bootstrap.project.scene = sampled.scene;
  sampledBundle.samples.frames = sampled.frames;
  // Imported/splat descriptors do not affect the already resolved transforms.
  // Use non-fetchable fixture identities; tests never read private campaign data.
  const scene = sampledBundle.bootstrap.project.scene;
  scene.environment.kind = 'splat';
  scene.environment.asset = {format: 'spz', path: `assets/${'1'.repeat(64)}.spz`, sha256: '1'.repeat(64)};
  scene.product.components[0].shape = 'mesh';
  scene.product.components[0].materialOverride = false;
  scene.product.components[0].asset = {format: 'glb', path: `assets/${'2'.repeat(64)}.glb`, sha256: '2'.repeat(64)};
  scene.product.components[0].sourceNodes = [{nodeIndex: 0, parentIndex: null, drawable: true, hasMesh: true, name: 'Body'}];
});
afterAll(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
const clone = <T>(value: T): T => structuredClone(value);

function closeToPython(actual: any, expected: any): void {
  if (typeof expected === 'number') expect(actual).toBeCloseTo(expected, 12);
  else if (Array.isArray(expected)) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) => closeToPython(actual[index], value));
  } else if (expected && typeof expected === 'object') {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) closeToPython(actual[key], expected[key]);
  } else expect(actual).toEqual(expected);
}

describe('the original browser demo', () => {
  it('matches every Python-evaluated frame without using a backend', async () => {
    const result = await evaluateDemoScene(bundle.bootstrap.project.scene, bundle);
    closeToPython(result.frames, bundle.samples.frames);
    expect(result.objects).toEqual(bundle.samples.objects);
    expect(result.digest).toMatch(/^demo-[a-f0-9]{64}$/);
  });

  it('matches canonical Python frames after cap timing and camera changes', async () => {
    const result = await evaluateDemoScene(changed, bundle);
    closeToPython(result.frames, golden.frames);
    expect(result.frames[60].components.cap.translationM[1]).toBeGreaterThan(bundle.samples.frames[60].components.cap.translationM[1]);
  });

  it('applies material, label mapping and offline room edits without changing geometry', async () => {
    const scene = clone(bundle.bootstrap.project.scene);
    scene.product.components[0].material = { baseColor: [.5, .2, .1, 1], roughness: .08, metallic: .8, transmission: .2, ior: 1.7 };
    scene.product.components[3].labelTexture.mapping = { mode: 'cylindrical', face: 'front', scale: [.4, .6], offset: [.1, -.2], rotationDegrees: 37 };
    scene.product.components[3].labelTexture.material.roughness = .25;
    scene.environment = clone(bundle.bootstrap.worlds[1].environment);
    const result = await evaluateDemoScene(scene, bundle);
    expect(result.scene).toEqual(scene);
    expect(result.frames).toEqual(bundle.samples.frames);
    expect(result.digest).not.toEqual((await evaluateDemoScene(bundle.bootstrap.project.scene, bundle)).digest);
  });

  it('rejects unsupported geometry, external textures, comparisons and invalid camera/movement', async () => {
    const edits = [
      (scene: any) => { scene.product.components[0].sizeM[0] = 100; },
      (scene: any) => { scene.placement.translationM[0] = 1; },
      (scene: any) => { scene.product.components[3].labelTexture.asset.path = 'https://external.test/image.png'; },
      (scene: any) => { scene.comparison = {}; },
      (scene: any) => { scene.actions[0].durationSeconds = 100; },
      (scene: any) => { scene.shots[0].camera.from.positionM = [0, 1, 0]; scene.shots[0].camera.to.positionM = [0, 2, 0]; },
    ];
    for (const edit of edits) {
      const scene = clone(bundle.bootstrap.project.scene); edit(scene);
      await expect(evaluateDemoScene(scene, bundle)).rejects.toThrow('Browser demo:');
    }
  });

  it('never sends a server mutation and only fetches the two packaged JSON files', async () => {
    const fetcher = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/samples.json') ? bundle.samples : bundle.bootstrap }));
    vi.stubGlobal('fetch', fetcher);
    for (const [path, method] of [['/api/renders', 'POST'], ['/api/projects/demo', 'PUT'], ['/api/github-worlds/generate', 'POST'], ['/api/textures/import', 'POST']]) {
      await expect(demoApi(path, method, {})).rejects.toThrow('needs the connected backend');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await demoApi('/api/jobs')).toEqual([]);
    expect(await demoApi('/api/comparison-renders')).toEqual([]);
    const bootstrapped = await demoApi('/api/bootstrap');
    bootstrapped.project.name = 'mutating the response does not alter the fixture';
    expect((await demoApi('/api/projects/demo')).name).toBe('Gesso / browser demo');
    expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/repository/demo/bootstrap.json', '/repository/demo/samples.json']);
    expect(fetcher.mock.calls.every(([, options]) => !(options as any)?.method)).toBe(true);
    await expect(demoApi('/api/github-worlds/runs')).rejects.toThrow('No server request was made');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('a packaged imported campaign', () => {
  it('preserves canonical scaled assembly and Film motion samples exactly', async () => {
    const result = await evaluateDemoScene(sampledBundle.bootstrap.project.scene, sampledBundle);
    expect(result.frames).toEqual(sampledBundle.samples.frames);
    expect(result.frames[60].camera).not.toEqual(bundle.samples.frames[60].camera);
    expect(result.frames[60].components.cap.scale).toBe(.37);
    result.frames[0].camera.positionM[0] = 99;
    expect(sampledBundle.samples.frames[0].camera.positionM[0]).not.toBe(99);
  });

  it('keeps motion exact when surfaces, assignments, labels and names change', async () => {
    const scene = clone(sampledBundle.bootstrap.project.scene);
    const surface = {baseColor: [.6, .1, .2, 1], roughness: .2, metallic: .5};
    scene.product.materialPresets = [{id: 'red', name: 'Red metal', type: 'metal', material: surface}];
    scene.product.components[0].materialBindings = [{nodeIndex: 0, materialPresetId: 'red'}];
    scene.product.components[1].material = surface;
    scene.editorPartNames = {'bottle-body::node:0': 'Bottle'};
    scene.editorHierarchy = {version: 1, overrides: {'bottle-body::node:0': {parentId: 'bottle-body', status: 'edited'}}};
    scene.shots[0].name = 'A closer look';
    scene.render.width = 1920;
    scene.render.height = 1080;
    const result = await evaluateDemoScene(scene, sampledBundle);
    expect(result.frames).toEqual(sampledBundle.samples.frames);
    expect(result.scene).toEqual(scene);
  });

  it('updates only optical focus fields and removed parts while keeping transforms', async () => {
    const scene = clone(sampledBundle.bootstrap.project.scene);
    scene.shots[0].camera.depthOfField = {enabled: true, fStop: 1.4, focusDistanceM: .3};
    scene.product.removedPartIds = ['bottle-body::node:0'];
    const result = await evaluateDemoScene(scene, sampledBundle);
    expect(result.frames[0].camera.depthOfField).toEqual({enabled: true, fStop: 1.4, focusDistanceM: .3});
    expect(result.frames[0].components).toEqual(sampledBundle.samples.frames[0].components);
    expect(result.frames[150].camera).toEqual(sampledBundle.samples.frames[150].camera);
    expect(result.frames[150].removedPartIds).toEqual(['bottle-body::node:0']);
  });

  it('switches between bundled worlds and restores the original without changing any pose', async () => {
    const original = sampledBundle.bootstrap.project.scene;
    for (const world of sampledBundle.bootstrap.worlds) {
      const scene = clone(original);
      scene.environment = clone(world.environment);
      // The application retains its support geometry when swapping a backdrop.
      for (const key of ['plinth', 'props', 'floorY', 'studioSizeM']) {
        if (Object.hasOwn(original.environment, key)) scene.environment[key] = clone(original.environment[key]);
        else delete scene.environment[key];
      }
      scene.environment.worldColor = [.15, .2, .3];
      const result = await evaluateDemoScene(scene, sampledBundle);
      expect(result.scene.environment).toEqual(scene.environment);
      expect(result.scene.placement).toEqual(original.placement);
      expect(result.frames).toEqual(sampledBundle.samples.frames);
      expect(result.objects).toEqual(sampledBundle.samples.objects);
      result.scene.environment = clone(original.environment);
      const restored = await evaluateDemoScene(result.scene, sampledBundle);
      expect(restored.scene).toEqual(original);
      expect(restored.frames).toEqual(sampledBundle.samples.frames);
    }
  });

  it('rejects unknown worlds and changes to bundled alignment or support geometry', async () => {
    const scene = clone(sampledBundle.bootstrap.project.scene);
    scene.environment = clone(sampledBundle.bootstrap.worlds[1].environment);
    const edits = [
      (value: any) => {value.environment.asset.path = `assets/${'f'.repeat(64)}.glb`;},
      (value: any) => {value.environment.asset.sha256 = 'f'.repeat(64);},
      (value: any) => {value.environment.revisionId = 'unbundled-world';},
      (value: any) => {value.environment.asset.translationM[0] += .1;},
      (value: any) => {value.environment.asset.rotationXyzw = [1, 0, 0, 0];},
      (value: any) => {value.environment.asset.scaleToMeters *= 2;},
      (value: any) => {value.environment.asset.sourceUp = 'Z';},
      (value: any) => {value.environment.collider = {asset: clone(value.environment.asset)};},
      (value: any) => {value.environment.plinth.sizeM[0] *= 2;},
      (value: any) => {value.environment.floorY = .5;},
      (value: any) => {value.environment.studioSizeM = [20, 20, 20];},
      (value: any) => {value.environment.props = [{id: 'new-prop'}];},
      (value: any) => {value.placement.translationM[0] += .1;},
    ];
    for (const edit of edits) {
      const changed = clone(scene); edit(changed);
      await expect(evaluateDemoScene(changed, sampledBundle)).rejects.toThrow('Browser demo:');
    }
  });

  it('rejects pose, timing, geometry, unbundled assets and malformed surface edits', async () => {
    const edits = [
      (scene: any) => {scene.placement.scale = 2;},
      (scene: any) => {scene.shots[0].motions[0].amount = 10;},
      (scene: any) => {scene.shots[0].camera.from.positionM[0] += .1;},
      (scene: any) => {scene.shots[0].endFrame -= 1;},
      (scene: any) => {scene.render.fps = 30;},
      (scene: any) => {scene.environment.asset.path = 'https://outside.test/world.spz';},
      (scene: any) => {scene.product.components[0].sizeM[0] = 1;},
      (scene: any) => {scene.product.components[0].material.baseColor[0] = -1;},
      (scene: any) => {scene.product.components[0].material.textures = {basecolor: {path: 'https://outside.test/map.png'}};},
      (scene: any) => {scene.product.components[0].materialBindings = [{nodeIndex: 99999, materialPresetId: 'missing'}];},
      (scene: any) => {scene.shots[0].camera.depthOfField = {fStop: 0};},
      (scene: any) => {scene.editorPartNames = {'unknown-part': 'Unknown'};},
    ];
    for (const edit of edits) {
      const scene = clone(sampledBundle.bootstrap.project.scene); edit(scene);
      await expect(evaluateDemoScene(scene, sampledBundle)).rejects.toThrow('Browser demo:');
    }
  });
});
