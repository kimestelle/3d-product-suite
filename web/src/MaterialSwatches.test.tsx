import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import MaterialSwatches from './MaterialSwatches';
import {MATERIAL_PRESETS} from './materials';

describe('Material swatch accessibility', () => {
  it('keeps material selection native and named before GPU previews are available', () => {
    const html = renderToStaticMarkup(<MaterialSwatches items={MATERIAL_PRESETS} selectedId="metal" onSelect={() => {}}/>);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(MATERIAL_PRESETS.length);
    MATERIAL_PRESETS.forEach(({name}, index) => {
      expect(buttons[index]).toContain('type="button"');
      expect(buttons[index]).toContain(`aria-label="${name}"`);
      expect(buttons[index]).not.toContain('disabled');
      expect(buttons[index]).toContain(`aria-pressed="${name === 'Metal'}"`);
    });
    expect(html).toMatch(/<canvas[^>]*aria-hidden="true"/);
  });

  it('disables native selection when its source component cannot accept an override', () => {
    const html = renderToStaticMarkup(<MaterialSwatches items={MATERIAL_PRESETS} disabled onSelect={() => {}}/>);
    expect(html.match(/<button\b[^>]*disabled=""/g)).toHaveLength(MATERIAL_PRESETS.length);
  });

  it('describes a rectangular sample while preserving list assignment content and native selection', () => {
    const html = renderToStaticMarkup(<MaterialSwatches items={MATERIAL_PRESETS.slice(0, 1)} shape="rectangle" layout="list"
      itemProps={() => ({'aria-label': 'Glass assignments'})} renderBelow={() => <span>lamp shade</span>} onSelect={() => {}}/>);
    expect(html).toContain('52 × 40 mm preview tile'); expect(html).toContain('is-list');
    expect(html).toContain('Glass assignments'); expect(html).toContain('lamp shade');
    expect(html).toContain('aria-label="Glass"');
  });
});
