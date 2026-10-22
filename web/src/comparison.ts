/** Persisted A/B worlds share the product, camera, plinth, props, and background. */
export type Side = 'a' | 'b';
export type ComparisonMode = 'a' | 'b' | 'split';
export interface World { id: string; name: string; environment: any }
export interface Comparison {
  schemaVersion: 1;
  alternative: any;
  calibration?: Partial<Record<Side, any>>;
  reviewedAlignmentDigest?: string;
}

const sharedFields = ['plinth', 'props', 'worldColor', 'studioSizeM'] as const;
const clone = <T>(value: T): T => structuredClone(value);

/** B stores only world-specific data; shared fields always come from A. */
export function stripSharedEnvironment(environment: any): any {
  const result = clone(environment);
  for (const field of sharedFields) delete result[field];
  return result;
}

function environmentOf(world: any): any {
  return world?.environment ?? world;
}

function providerWorldId(world: any): string | undefined {
  const id = environmentOf(world)?.provenance?.providerWorldId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

/** Unknown provenance can be compared manually; known different generations cannot. */
export function compatibleWorlds(a: any, b: any): boolean {
  const aId = providerWorldId(a), bId = providerWorldId(b);
  return !aId || !bId || aId === bId;
}

/** Choose final meshes from one real generation, or image-free authored defaults. */
export function chooseComparisonPair(worlds: World[]): { a: World; b: World } | null {
  for (const a of worlds) {
    if (a.environment?.kind !== 'mesh' || a.environment.fixture ||
        a.environment.provenance?.representation !== 'hq-visual-glb' || !providerWorldId(a)) continue;
    const b = worlds.find(candidate => candidate.environment?.kind === 'mesh' &&
      !candidate.environment.fixture &&
      candidate.environment.provenance?.representation === 'gaussian-reconstructed-mesh' &&
      providerWorldId(candidate) === providerWorldId(a));
    if (b) return { a, b };
  }
  const defaultName = (world: World) => (world.environment?.displayName ?? world.name)
    .toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const a = worlds.find(world => world.environment?.kind === 'mesh' &&
    /^default\s*·\s*gallery$/.test(defaultName(world)));
  const b = worlds.find(world => world.environment?.kind === 'mesh' &&
    /^default\s*·\s*botanical(?: room)?$/.test(defaultName(world)));
  return a && b ? { a, b } : null;
}

/** A library revision includes alignment, so identical GLB bytes alone cannot identify it. */
export function matchWorldRevision(worlds: World[], environment: any): World | undefined {
  for (const revision of [environment?.revisionId, environment?.worldRevisionId]) {
    if (typeof revision !== 'string' || !revision) continue;
    const exact = worlds.find(world => world.id === revision || world.environment?.revisionId === revision);
    if (exact) return exact;
  }
  const asset = environment?.asset;
  if (typeof asset?.sha256 !== 'string' || !asset.sha256) return undefined;
  const transformFields = ['sourceUp', 'scaleToMeters', 'translationM', 'rotationXyzw'] as const;
  return worlds.find(world => {
    const candidate = world.environment?.asset;
    return candidate?.sha256 === asset.sha256 && transformFields.every(field =>
      asset[field] !== undefined && candidate[field] !== undefined &&
      JSON.stringify(candidate[field]) === JSON.stringify(asset[field]));
  });
}

function withSharedEnvironment(worldEnvironment: any, sharedEnvironment: any): any {
  const result = stripSharedEnvironment(worldEnvironment);
  for (const field of sharedFields) {
    if (Object.prototype.hasOwnProperty.call(sharedEnvironment, field)) {
      result[field] = clone(sharedEnvironment[field]);
    }
  }
  return result;
}

function invalidateAlignment(comparison: Comparison, side: Side): void {
  delete comparison.reviewedAlignmentDigest;
  if (comparison.calibration) delete comparison.calibration[side];
}

function requireComparison(scene: any): Comparison {
  if (scene.comparison?.schemaVersion !== 1 || !scene.comparison.alternative) {
    throw new Error('Enable A/B comparison before changing a comparison world.');
  }
  return scene.comparison;
}

/** Start with one matched pair while retaining all explicit shared scene objects. */
export function enableComparison<T extends Record<string, any>>(scene: T, worlds: World[]): T {
  const pair = chooseComparisonPair(worlds);
  if (!pair) throw new Error('No matching world pair or default environments are available.');
  const next: any = clone(scene);
  const currentSha = scene.environment?.asset?.sha256;
  const currentIsA = currentSha && currentSha === pair.a.environment.asset?.sha256;
  const currentIsB = currentSha && currentSha === pair.b.environment.asset?.sha256;
  next.environment = withSharedEnvironment(currentIsA ? scene.environment : pair.a.environment, scene.environment);
  next.comparison = {
    schemaVersion: 1,
    alternative: stripSharedEnvironment(currentIsB ? scene.environment : pair.b.environment),
  };
  return next;
}

/** Replace one side without duplicating near-field geometry into the alternative. */
export function setComparisonWorld<T extends Record<string, any>>(scene: T, side: Side, world: World): T {
  const next: any = clone(scene);
  const comparison = requireComparison(next);
  const other = side === 'a' ? comparison.alternative : next.environment;
  if (!compatibleWorlds(world, other)) {
    throw new Error('Compare meshes from the same provider world, or choose an authored environment.');
  }
  if (side === 'a') next.environment = withSharedEnvironment(world.environment, next.environment);
  else comparison.alternative = stripSharedEnvironment(world.environment);
  invalidateAlignment(comparison, side);
  return next;
}

/** Apply an asset edit to a clone, invalidating only that side's alignment evidence. */
export function updateWorldTransform<T extends Record<string, any>>(
  scene: T, side: Side, edit: (asset: any) => any,
): T {
  const next: any = clone(scene);
  const comparison = requireComparison(next);
  const environment = side === 'a' ? next.environment : comparison.alternative;
  if (!environment.asset) throw new Error(`World ${side.toUpperCase()} has no asset transform to edit.`);
  const replacement = edit(environment.asset);
  if (replacement !== undefined) environment.asset = clone(replacement);
  invalidateAlignment(comparison, side);
  return next;
}

export function comparisonLabels(scene: any): { a: string; b: string } {
  return {
    a: scene.environment?.displayName ?? (scene.environment?.kind === 'authored' ? 'Authored studio' : 'World A'),
    b: scene.comparison?.alternative?.displayName ?? 'World B',
  };
}
