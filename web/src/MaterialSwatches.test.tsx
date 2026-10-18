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
});
