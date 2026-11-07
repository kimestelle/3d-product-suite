import {describe, expect, it} from 'vitest';
import {resolveSaveStatus, saveStatusPresentation} from './saveStatus';

const idle = {saving: false, loaded: true, busy: false, dirty: false};
describe('revision save status', () => {
  it('only reports saved for an idle, loaded, clean revision', () => {
    expect(resolveSaveStatus(idle)).toBe('saved');
    expect(resolveSaveStatus({...idle, dirty: true})).toBe('unsaved');
  });
  it('does not report saved while opening a campaign', () => {
    expect(resolveSaveStatus({...idle, loaded: false})).toBe('opening');
    expect(resolveSaveStatus({...idle, loaded: false, busy: true})).toBe('opening');
  });
  it('reports unrelated operations without suggesting a save', () => {
    expect(resolveSaveStatus({...idle, busy: true})).toBe('working');
    expect(resolveSaveStatus({...idle, busy: true, dirty: true})).toBe('working');
  });
  it('keeps saving visible across the dirty-to-clean response update', () => {
    expect(resolveSaveStatus({...idle, saving: true, busy: true, dirty: true})).toBe('saving');
    expect(resolveSaveStatus({...idle, saving: true, busy: true, dirty: false})).toBe('saving');
  });
  it('returns to save for failed requests or changes made during a save', () => {
    expect(resolveSaveStatus({...idle, dirty: true})).toBe('unsaved');
  });
  it.each(['material', 'film', 'transform'] as const)('names the canonical original while a %s preview is visible', preview => {
    expect(saveStatusPresentation(resolveSaveStatus(idle), preview).label).toBe('Original saved');
    expect(saveStatusPresentation(resolveSaveStatus({...idle, dirty: true}), preview).label).toBe('Save original');
    expect(saveStatusPresentation(resolveSaveStatus({...idle, saving: true}), preview).label).toBe('Saving original…');
    expect(saveStatusPresentation('saved', preview).title).toContain('preview is not included');
  });
  it('keeps operation priority while a preview is visible and restores ordinary labels afterward', () => {
    expect(saveStatusPresentation('opening', 'film').label).toBe('Opening…');
    expect(saveStatusPresentation('working', 'material').label).toBe('Working…');
    expect(saveStatusPresentation('saved', null).label).toBe('Saved');
    expect(saveStatusPresentation('unsaved', null).label).toBe('Save');
    expect(saveStatusPresentation('saved', 'film').title).toContain('Keep film');
    expect(saveStatusPresentation('unsaved', 'material').title).toContain('Save the material first');
  });
});
