import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateDemoScene, type DemoBundle } from './demo';

vi.mock('./runtime', () => ({ demoDataUrl: (filename = 'bootstrap.json') => '/demo/' + filename }));
const directory = process.env.GESSO_DEMO_DIR ?? fileURLToPath(new URL('../public/demo/', import.meta.url));
const bootstrapPath = join(directory, 'bootstrap.json');
const samplesPath = join(directory, 'samples.json');
const available = existsSync(bootstrapPath) && existsSync(samplesPath);
if (process.env.GESSO_DEMO_DIR && !available) throw new Error('GESSO_DEMO_DIR must contain bootstrap.json and samples.json.');
const bundle: DemoBundle | null = available ? {
  bootstrap: JSON.parse(readFileSync(bootstrapPath, 'utf8')),
  samples: JSON.parse(readFileSync(samplesPath, 'utf8')),
} : null;

if (process.env.GESSO_DEMO_DIR && bundle?.bootstrap.demo?.playbackMode !== 'sampled') throw new Error('GESSO_DEMO_DIR must contain a sampled campaign.');

describe.skipIf(bundle?.bootstrap.demo?.playbackMode !== 'sampled')('the built campaign bundle', () => {
  it('opens the bundled imported campaign with byte-equivalent canonical sample values', async () => {
    const result = await evaluateDemoScene(bundle!.bootstrap.project.scene, bundle!);
    expect(result.frames).toEqual(bundle!.samples.frames);
    expect(result.objects).toEqual(bundle!.samples.objects);
    expect(result.scene).toEqual(bundle!.bootstrap.project.scene);
  });

  it('plays each packaged world and returns to the original with identical film samples', async () => {
    const original = bundle!.bootstrap.project.scene;
    for (const world of bundle!.bootstrap.worlds) {
      const scene = structuredClone(original);
      scene.environment = structuredClone(world.environment);
      for (const key of ['plinth', 'props', 'floorY', 'studioSizeM']) {
        if (Object.hasOwn(original.environment, key)) scene.environment[key] = structuredClone(original.environment[key]);
        else delete scene.environment[key];
      }
      const result = await evaluateDemoScene(scene, bundle!);
      expect(result.scene.environment.asset).toEqual(world.environment.asset);
      expect(result.frames).toEqual(bundle!.samples.frames);
      expect(result.objects).toEqual(bundle!.samples.objects);
      expect(result.scene.placement).toEqual(original.placement);
      result.scene.environment = structuredClone(original.environment);
      expect((await evaluateDemoScene(result.scene, bundle!)).scene).toEqual(original);
      scene.environment.asset.path = 'assets/not-packaged.glb';
      await expect(evaluateDemoScene(scene, bundle!)).rejects.toThrow('included environments');
    }
  });

  it('opens the neutral authored studio without changing sampled placement or motion', async () => {
    const scene = structuredClone(bundle!.bootstrap.project.scene);
    const environment = scene.environment;
    delete environment.asset; delete environment.fixture; delete environment.collider;
    environment.kind = 'authored'; environment.revisionId = 'neutral-studio-v1'; environment.displayName = 'Authored studio';
    environment.provenance = {source:'Original authored studio',owner:'3d-product-suite',reuseBasis:'Original project geometry',allowedExternalDestinations:[]};
    const result = await evaluateDemoScene(scene, bundle!);
    expect(result.frames).toEqual(bundle!.samples.frames);
    expect(result.scene.placement).toEqual(bundle!.bootstrap.project.scene.placement);
    scene.environment.asset = {path:'assets/not-packaged.glb'};
    await expect(evaluateDemoScene(scene, bundle!)).rejects.toThrow('included environments');
  });

  it('assigns a starter surface to a real source node without disturbing the film', async () => {
    const scene = structuredClone(bundle!.bootstrap.project.scene);
    const component = scene.product.components.find((item: any) => item.sourceNodes?.some((node: any) => node.hasMesh));
    expect(component).toBeTruthy();
    const node = component.sourceNodes.find((item: any) => item.hasMesh);
    scene.product.materialPresets = [{id: 'test-red', name: 'Red plastic', type: 'plastic',
      material: {baseColor: [.6, .018, .008, 1], roughness: .3, metallic: 0}}];
    component.materialBindings = [{nodeIndex: node.nodeIndex, materialPresetId: 'test-red'}];
    const result = await evaluateDemoScene(scene, bundle!);
    expect(result.frames).toEqual(bundle!.samples.frames);
    expect(result.scene.product.components).toEqual(scene.product.components);
  });
});
