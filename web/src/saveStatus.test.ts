import {describe, expect, it} from 'vitest';
import {resolveSaveStatus} from './saveStatus';

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
});
