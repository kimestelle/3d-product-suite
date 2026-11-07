import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {UiIcon} from './UiIcon';
import {UI_ICON_CATALOG} from './uiIconCatalog';

describe('UiIcon', () => {
  it('keeps every assigned role renderable without a mask asset or separate accessible target', () => {
    for (const {name} of UI_ICON_CATALOG) {
      const markup = renderToStaticMarkup(<UiIcon name={name}/>);
      expect(markup).toContain('<svg');
      expect(markup).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
      expect(markup).not.toContain('mask-image');
      expect(markup).not.toContain('tabindex');
    }
  });

  it('honors explicit dimensions while retaining a fixed visible stroke at both dense and prominent sizes', () => {
    for (const size of [12, 14, 16, 20]) {
      const markup = renderToStaticMarkup(<UiIcon name="camera" size={size}/>);
      expect(markup).toContain(`width="${size}" height="${size}"`);
      expect(markup).toContain(`style="width:${size}px;height:${size}px"`);
      expect(markup).toContain('stroke-width="1.5"');
      expect(markup).toContain('vector-effect="non-scaling-stroke"');
    }
  });

  it('retains consumer hooks and inherits control colour', () => {
    const markup = renderToStaticMarkup(<UiIcon name="eyeoff" className="is-muted"/>);
    expect(markup).toContain('gesso-ui-icon is-muted');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('fill="none"');
  });

  it('uses the role default when a computed dimension is invalid', () => {
    for (const size of [0, -1, NaN, Infinity]) {
      expect(renderToStaticMarkup(<UiIcon name="history" size={size}/>)).toContain('width="16" height="16"');
    }
  });
});
