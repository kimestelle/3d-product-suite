import { describe, expect, it } from 'vitest';
import {
  chooseComparisonPair, compatibleWorlds, comparisonLabels, enableComparison, matchWorldRevision,
  setComparisonWorld, stripSharedEnvironment, updateWorldTransform, type World,
} from './comparison';
import { commitHistory, createHistory, redoHistory, undoHistory } from './state';

function world(name: string, representation?: string, providerWorldId?: string, fixture = false): World {
  return { id: name, name, environment: {
    revisionId: name, kind: 'mesh', displayName: name, fixture,
    asset: { path: `assets/${name}.glb`, sourceUp: 'Y', scaleToMeters: 1, translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1] },
    provenance: { representation, providerWorldId },
    plinth: { id: 'world-plinth', sizeM: [4, 5, 6] }, props: [{ id: 'world-prop' }], worldColor: [1, 0, 0],
  } };
}
const official = (id = 'generation-1') => world(`Official ${id}`, 'hq-visual-glb', id);
const gaussian = (id = 'generation-1') => world(`Gaussian ${id}`, 'gaussian-reconstructed-mesh', id);
const defaults = () => [world('Default · Gallery', undefined, undefined, true), world('Default · Botanical room', undefined, undefined, true)];
function scene() {
  return {
    product: { label: 'NOVA', components: [{ id: 'bottle' }] },
    camera: { fov: 31 }, actions: [{ id: 'lift' }],
    environment: { kind: 'authored', displayName: 'Studio', plinth: { id: 'custom-plinth', sizeM: [.4, .07, .3] },
      props: [{ id: 'my-prop', translationM: [1, 2, 3] }], worldColor: [.1, .2, .3] },
  };
}

describe('persisted A/B worlds', () => {
  it('strips cloned shared fields without dropping world-specific provenance or transforms', () => {
    const original = gaussian().environment;
    const result = stripSharedEnvironment(original);
    expect(result).not.toHaveProperty('plinth');
    expect(result).not.toHaveProperty('props');
    expect(result).not.toHaveProperty('worldColor');
    expect(result.provenance).toEqual(original.provenance);
    result.asset.translationM[0] = 99;
    expect(original.asset.translationM).toEqual([0, 0, 0]);
  });

  it('prefers complete real same-generation final meshes over defaults, fixtures, or raw splats', () => {
    const fixtureA = official('fixture'), fixtureB = gaussian('fixture');
    fixtureA.environment.fixture = fixtureB.environment.fixture = true;
    const wrong = gaussian('other-generation');
    const raw = world('Raw splat', 'gaussian-spz', 'generation-1'); raw.environment.kind = 'splat';
    const a = official(), b = gaussian();
    expect(chooseComparisonPair([...defaults(), fixtureA, fixtureB, wrong, raw, a, b])).toEqual({ a, b });
    expect(chooseComparisonPair([a, wrong, raw])).toBeNull();
    expect(chooseComparisonPair([fixtureA, fixtureB])).toBeNull();
  });

  it('uses both offline defaults when no complete real provider pair exists', () => {
    const [a, b] = defaults();
    expect(chooseComparisonPair([official(), b, a])).toEqual({ a, b });
    expect(chooseComparisonPair([a])).toBeNull();
    expect(() => enableComparison(scene(), [])).toThrow('No matching world pair');
  });

  it('selects the exact revision among multiple alignments of the same GLB', () => {
    const raw = official(), calibrated = official();
    raw.id = raw.environment.revisionId = 'raw-revision';
    calibrated.id = calibrated.environment.revisionId = 'calibrated-revision';
    raw.environment.asset.sha256 = calibrated.environment.asset.sha256 = 'same-glb';
    calibrated.environment.asset.translationM[1] = .75;
    calibrated.environment.asset.scaleToMeters = 1.7;
    expect(matchWorldRevision([raw, calibrated], structuredClone(calibrated.environment))).toBe(calibrated);
    const edited = { ...structuredClone(calibrated.environment), revisionId: 'edited-revision', worldRevisionId: 'calibrated-revision' };
    edited.asset.translationM[1] = 5;
    expect(matchWorldRevision([raw, calibrated], edited)).toBe(calibrated);
    // Imported entry identities may differ from their environment revision identity.
    calibrated.id = 'library-entry';
    expect(matchWorldRevision([raw, calibrated], calibrated.environment)).toBe(calibrated);
  });

  it('falls back to identical asset bytes and every alignment field for unknown revisions', () => {
    const raw = official(), aligned = official();
    raw.id = raw.environment.revisionId = 'raw-revision';
    aligned.id = aligned.environment.revisionId = 'aligned-revision';
    raw.environment.asset.sha256 = aligned.environment.asset.sha256 = 'same-glb';
    aligned.environment.asset.translationM = [0, .8, 0];
    aligned.environment.asset.scaleToMeters = 1.7;
    const unknown = { ...structuredClone(aligned.environment), revisionId: 'not-in-library' };
    expect(matchWorldRevision([raw, aligned], unknown)).toBe(aligned);
    for (const [field, value] of [
      ['sourceUp', 'Z'], ['scaleToMeters', 3], ['translationM', [1, .8, 0]], ['rotationXyzw', [1, 0, 0, 0]],
    ] as const) {
      const different = structuredClone(unknown);
      different.asset[field] = value;
      expect(matchWorldRevision([raw, aligned], different)).toBeUndefined();
    }
    expect(matchWorldRevision([raw, aligned], { asset: { sha256: 'same-glb' } })).toBeUndefined();
    expect(matchWorldRevision([raw, aligned], { asset: { ...unknown.asset, sha256: 'other-glb' } })).toBeUndefined();
  });

  it('retains current calibrated single-world alignment on either matching comparison side', () => {
    const a = official(), b = gaussian();
    a.environment.asset.sha256 = 'official-glb'; b.environment.asset.sha256 = 'gaussian-glb';
    for (const [side, currentWorld] of [['a', a], ['b', b]] as const) {
      const original: any = scene();
      original.environment = {
        ...structuredClone(currentWorld.environment),
        plinth: original.environment.plinth, props: original.environment.props, worldColor: original.environment.worldColor,
      };
      original.environment.revisionId = 'current-calibration';
      original.environment.displayName = 'My calibrated world';
      original.environment.asset.scaleToMeters = 1.703;
      original.environment.asset.translationM = [0, .83, -.4];
      original.environment.asset.rotationXyzw = [1, 0, 0, 0];
      const before = structuredClone(original);
      const enabled: any = enableComparison(original, [a, b]);
      const matching = side === 'a' ? enabled.environment : enabled.comparison.alternative;
      expect(matching.asset).toEqual(original.environment.asset);
      expect(matching.revisionId).toBe('current-calibration');
      expect(matching.displayName).toBe('My calibrated world');
      for (const field of ['plinth', 'props', 'worldColor']) expect(enabled.environment[field]).toEqual(original.environment[field]);
      expect(enabled.comparison.alternative).not.toHaveProperty('plinth');
      expect(enabled.comparison.alternative).not.toHaveProperty('props');
      expect(enabled.comparison.alternative).not.toHaveProperty('worldColor');
      expect(original).toEqual(before);
      matching.asset.translationM[1] = 10;
      expect(original.environment.asset.translationM[1]).toBe(.83);
    }
  });

  it('preserves the materialized product, camera, and shared environment when enabling comparison', () => {
    const original = scene(), before = structuredClone(original), worlds = [official(), gaussian()];
    const result: any = enableComparison(original, worlds);
    expect(original).toEqual(before);
    expect(result.product).toEqual(original.product);
    expect(result.camera).toEqual(original.camera);
    expect(result.actions).toEqual(original.actions);
    for (const field of ['plinth', 'props', 'worldColor'] as const) expect(result.environment[field]).toEqual(original.environment[field]);
    expect(result.comparison.schemaVersion).toBe(1);
    expect(result.comparison.alternative).toEqual(stripSharedEnvironment(worlds[1].environment));
    result.environment.props[0].translationM[0] = 99;
    result.comparison.alternative.asset.translationM[0] = 55;
    expect(original.environment.props[0].translationM[0]).toBe(1);
    expect(worlds[1].environment.asset.translationM[0]).toBe(0);
  });

  it('keeps absent shared props absent rather than adopting a library world’s props', () => {
    const original: any = scene(); delete original.environment.props;
    const enabled: any = enableComparison(original, defaults());
    expect(enabled.environment).not.toHaveProperty('props');
    const changed: any = setComparisonWorld(enabled, 'a', defaults()[1]);
    expect(changed.environment).not.toHaveProperty('props');
    expect(changed.comparison.alternative).not.toHaveProperty('props');
  });

  it('rejects known generation mismatches while allowing authored/unknown worlds', () => {
    expect(compatibleWorlds(official(), gaussian())).toBe(true);
    expect(compatibleWorlds(official().environment, gaussian('different').environment)).toBe(false);
    expect(compatibleWorlds(official(), defaults()[0])).toBe(true);
    const enabled: any = enableComparison(scene(), [official(), gaussian()]);
    expect(() => setComparisonWorld(enabled, 'a', official('different'))).toThrow('same provider world');
    expect(() => setComparisonWorld(enabled, 'b', gaussian('different'))).toThrow('same provider world');
    expect(enabled.comparison.alternative.provenance.providerWorldId).toBe('generation-1');
    expect(setComparisonWorld(enabled, 'b', defaults()[0]).comparison.alternative.displayName).toBe('Default · Gallery');
  });

  it('replaces either world while preserving shared state and only the other side’s calibration', () => {
    const enabled: any = enableComparison(scene(), defaults());
    enabled.comparison.calibration = { a: { heightM: 2 }, b: { heightM: 3 } };
    enabled.comparison.reviewedAlignmentDigest = 'reviewed';
    const a: any = setComparisonWorld(enabled, 'a', official());
    expect(a.environment.plinth).toEqual(enabled.environment.plinth);
    expect(a.environment.props).toEqual(enabled.environment.props);
    expect(a.environment.worldColor).toEqual(enabled.environment.worldColor);
    expect(a.comparison.calibration).toEqual({ b: { heightM: 3 } });
    expect(a.comparison).not.toHaveProperty('reviewedAlignmentDigest');
    const b: any = setComparisonWorld(enabled, 'b', gaussian());
    expect(b.environment).toEqual(enabled.environment);
    expect(b.comparison.calibration).toEqual({ a: { heightM: 2 } });
    expect(b.comparison.alternative).not.toHaveProperty('plinth');
    expect(enabled.comparison.reviewedAlignmentDigest).toBe('reviewed');
  });

  it('edits isolated asset transforms and invalidates only corresponding alignment evidence', () => {
    const original: any = enableComparison(scene(), [official(), gaussian()]);
    original.comparison.calibration = { a: { mark: [1, 2] }, b: { mark: [3, 4] } };
    original.comparison.reviewedAlignmentDigest = 'reviewed';
    const edited: any = updateWorldTransform(original, 'b', asset => { asset.translationM[1] = -.2; asset.scaleToMeters = 1.7; });
    expect(edited.comparison.alternative.asset.translationM).toEqual([0, -.2, 0]);
    expect(edited.comparison.alternative.asset.scaleToMeters).toBe(1.7);
    expect(edited.environment).toEqual(original.environment);
    expect(edited.comparison.calibration).toEqual({ a: { mark: [1, 2] } });
    expect(edited.comparison).not.toHaveProperty('reviewedAlignmentDigest');
    expect(original.comparison.alternative.asset.translationM).toEqual([0, 0, 0]);
    const a: any = updateWorldTransform(original, 'a', asset => ({ ...asset, scaleToMeters: 2 }));
    expect(a.environment.asset.scaleToMeters).toBe(2);
    expect(a.comparison.calibration).toEqual({ b: { mark: [3, 4] } });
  });

  it('roundtrips through JSON and ordinary scene history for save, reopen, undo, and redo', () => {
    const original = scene();
    const enabled: any = enableComparison(original, defaults());
    const edited = updateWorldTransform(enabled, 'a', asset => { asset.translationM[0] = .5; });
    let history: any = createHistory(original);
    history = commitHistory(history, enabled);
    history = commitHistory(history, edited);
    expect(undoHistory(history).present).toEqual(enabled);
    expect(redoHistory(undoHistory(history)).present).toEqual(edited);
    const reopened = JSON.parse(JSON.stringify(edited));
    expect(reopened).toEqual(edited);
    expect(comparisonLabels(reopened)).toEqual({ a: 'Default · Gallery', b: 'Default · Botanical room' });
    expect(comparisonLabels({ environment: { kind: 'authored' } })).toEqual({ a: 'Authored studio', b: 'World B' });
    expect(() => updateWorldTransform(original, 'a', () => {})).toThrow('Enable A/B comparison');
  });
});
