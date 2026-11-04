import {describe, expect, it} from 'vitest';
import {exportExecutionLabel} from './exportModel';

describe('actual export execution labels', () => {
  it('makes no device claim for a legacy or queued export', () => {
    expect(exportExecutionLabel()).toBe('');
    expect(exportExecutionLabel({})).toBe('');
  });
  it('distinguishes GPU product rendering from software environment capture', () => {
    expect(exportExecutionLabel({cycles:{backend:'METAL'},gaussian:{backend:'software'}}))
      .toBe('Cycles · Metal GPU / Environment · software');
  });
  it('reports the actual CPU fallback', () => {
    expect(exportExecutionLabel({cycles:{backend:'CPU',fallbackReason:'No GPU'},gaussian:{backend:'hardware'}}))
      .toBe('Cycles · CPU (fallback) / Environment · GPU');
  });
});
