import {describe, expect, it, vi} from 'vitest';
import {createExportDraft, currentExportDraft, editExportDraft} from './exportDraft';
import type {RandomSetupSettings} from './randomSetup';

const sourceScene = () => ({product: {name: 'Lamp', color: [.8, .2, .1]}, render: {width: 1920, height: 1080}, shots: [{endFrame: 240}]});
const settings = (): RandomSetupSettings => ({
  policies: {stage: 'fill', lighting: 'fill', framing: 'fill', motion: 'fill', materials: 'keep', colors: 'keep'},
  stageIds: ['builtin:white'], paletteIds: ['neutral'], lightingStyles: ['soft'], cameraViews: ['front'], motionKinds: ['still'],
  materialPartIds: [], materialTypes: ['plastic'], durationSeconds: 10, shotCount: 1, aspect: 'keep',
});

describe('export candidates stay separate from the campaign', () => {
  it('isolates generated data and settings even when the generator returns the source', () => {
    const source = sourceScene(), original = structuredClone(source), choices = settings();
    const result = {scene: source, seed: 42, changes: ['Filled framing']};
    const draft = createExportDraft(source, 'lamp-project', result, choices);
    expect(draft.source).toBe(source);
    expect(draft.scene).not.toBe(source);
    draft.scene.product.color[0] = 0;
    expect(source).toEqual(original);
    choices.policies.stage = 'random'; choices.stageIds.push('builtin:dark');
    result.changes.push('Later change');
    expect(draft.settings.policies.stage).toBe('fill');
    expect(draft.settings.stageIds).toEqual(['builtin:white']);
    expect(draft.changes).toEqual(['Filled framing']);
    expect(draft.seed).toBe(42);
  });

  it('selects only the exact source revision and project, with no fallback to a stale candidate', () => {
    const source = sourceScene();
    const draft = createExportDraft(source, 'lamp-project', {scene: source, seed: 7, changes: []}, settings());
    expect(currentExportDraft(draft, source, 'lamp-project')).toBe(draft);
    expect(currentExportDraft(draft, structuredClone(source), 'lamp-project')).toBeNull();
    expect(currentExportDraft(draft, source, 'another-project')).toBeNull();
    expect(currentExportDraft(draft, source, null)).toBeNull();
    expect(currentExportDraft(draft, null, 'lamp-project')).toBeNull();
    expect(currentExportDraft(null, source, 'lamp-project')).toBeNull();
    // Toggling the selected source does not consume or alter the candidate.
    expect(currentExportDraft(draft, source, 'lamp-project')).toBe(draft);
  });

  it('applies composition changes to a new candidate while preserving the campaign and earlier preview', () => {
    const source = sourceScene(), original = structuredClone(source);
    const draft = createExportDraft(source, 'lamp-project', {scene: source, seed: 7, changes: ['New stage']}, settings());
    const edited = editExportDraft(draft, source, 'lamp-project', scene => {
      scene.render.width = 1080; scene.shots[0].endFrame = 48; scene.product.color[1] = .4;
    });
    expect(edited?.scene.render).toEqual({width: 1080, height: 1080});
    expect(edited?.scene.shots[0].endFrame).toBe(48);
    expect(edited?.source).toBe(source);
    expect(edited?.seed).toBe(7);
    expect(edited?.changes).toEqual(['New stage']);
    expect(edited?.settings).toEqual(settings());
    expect(draft.scene).toEqual(original);
    expect(source).toEqual(original);
  });

  it('never invokes an edit against a missing or stale candidate', () => {
    const source = sourceScene(), edit = vi.fn();
    const draft = createExportDraft(source, 'lamp-project', {scene: source, seed: 7, changes: []}, settings());
    expect(editExportDraft(draft, structuredClone(source), 'lamp-project', edit)).toBeNull();
    expect(editExportDraft(draft, source, 'another-project', edit)).toBeNull();
    expect(editExportDraft(null, source, 'lamp-project', edit)).toBeNull();
    expect(edit).not.toHaveBeenCalled();
  });

  it('keeps the previous preview and campaign intact when a candidate edit fails', () => {
    const source = sourceScene(), original = structuredClone(source);
    const draft = createExportDraft(source, 'lamp-project', {scene: source, seed: 7, changes: []}, settings());
    expect(() => editExportDraft(draft, source, 'lamp-project', scene => {
      scene.shots[0].endFrame = 0;
      throw new Error('Duration must be positive');
    })).toThrow('Duration must be positive');
    expect(source).toEqual(original);
    expect(draft.scene).toEqual(original);
  });
});
