import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { demoApi, evaluateDemoScene, type DemoBundle } from './demo';

vi.mock('./runtime', () => ({ demoDataUrl: (filename = 'bootstrap.json') => '/repository/demo/' + filename }));

let directory: string, bundle: DemoBundle, changed: any, golden: any;
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
  ].join('\n'), directory], { cwd: root });
  bundle = { bootstrap: JSON.parse(readFileSync(join(directory, 'bootstrap.json'), 'utf8')),
    samples: JSON.parse(readFileSync(join(directory, 'samples.json'), 'utf8')) };
  golden = JSON.parse(readFileSync(join(directory, 'changed.json'), 'utf8'));
  changed = golden.scene;
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
