import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import EditorNavigation, {EditorLayerNavigation} from './EditorNavigation';
import {groups} from './navigation';

function context() {
  return {group: 'renders' as const, onGroup: vi.fn(), exportActive: false, onExport: vi.fn()};
}

describe('editor export navigation', () => {
  it('retains the three main steps and shortcuts with Export after Film', () => {
    const html = renderToStaticMarkup(<EditorNavigation {...context()}/>);
    expect(html.indexOf('>Product<')).toBeLessThan(html.indexOf('>Stage<'));
    expect(html.indexOf('>Stage<')).toBeLessThan(html.indexOf('>Film<'));
    expect(html.indexOf('>Film<')).toBeLessThan(html.indexOf('>Export<'));
    for (const key of [1, 2, 3]) expect(html).toContain(`aria-keyshortcuts="Alt+${key}"`);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toContain('Film format');
  });

  it('selects only Export and keeps the underlying group recoverable', () => {
    const props = {...context(), exportActive: true};
    const html = renderToStaticMarkup(<EditorNavigation {...props}/>);
    expect(html).toContain('data-export-active="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    for (const {label} of groups) expect(html).toContain(`aria-label="${label}" aria-pressed="false"`);
    expect(html).toContain('class="gesso-export-tab gesso-export-tab-button" aria-pressed="true"');
    expect(html).toContain('--active-tab:2');
    expect(props.group).toBe('renders');
  });

  it('opens random setup without generating or changing a workspace', () => {
    const props = {...context(), onRandomSetup: vi.fn(), randomSetupActive: true};
    const nav = EditorNavigation(props), button = nav.props.children[1].props.children[0];
    if (!button) throw new Error('Missing random setup action');
    button.props.onClick();
    expect(props.onRandomSetup).toHaveBeenCalledOnce();
    expect(props.onExport).not.toHaveBeenCalled();
    expect(props.onGroup).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(<EditorNavigation {...props}/>);
    expect(html).toContain('aria-label="Random setup" title="Configure random setup" aria-pressed="true"');
    expect(html.indexOf('aria-label="Random setup"')).toBeLessThan(html.indexOf('>Export<'));
    expect(html).not.toContain('gesso-export-actions-surface');
    expect(html).toContain('gesso-export-tab-fill');
    const disabled = renderToStaticMarkup(<EditorNavigation {...props} exportDisabled/>);
    expect(disabled).toContain('title="Configure random setup" aria-pressed="true" disabled=""');
  });

  it('uses the parent Export action and native disabled behavior', () => {
    const props = context(), nav = EditorNavigation(props);
    const button = nav.props.children[1].props.children[1];
    button.props.onClick();
    expect(props.onExport).toHaveBeenCalledOnce();
    expect(props.onGroup).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<EditorNavigation {...props} exportDisabled/>)).toContain('aria-pressed="false" disabled=""');
  });
});


describe('sidebar layer navigation', () => {
  it('uses the same row for Product and Stage with visible shortcut annotations', () => {
    for (const group of ['product','world'] as const) {
      const html=renderToStaticMarkup(<EditorLayerNavigation group={group} layer={group==='world'?'Props':'Model'} onLayer={()=>{}}/>);
      expect(html).toContain('class="gesso-sidebar-layers"');
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      for (const digit of [5,6,7]) expect(html).toContain(`aria-keyshortcuts="Alt+${digit}"`);
    }
  });
  it('shows Objects / Lighting while navigating with the existing world keys', () => {
    const onLayer=vi.fn();
    const nav=EditorLayerNavigation({group:'world',layer:'Props',onLayer});
    const buttons=nav.props.children;
    expect(buttons.map((button:any)=>button.props['aria-label'])).toEqual(['Environment','Objects','Lighting']);
    buttons[1].props.onClick();buttons[2].props.onClick();
    expect(onLayer.mock.calls).toEqual([['Props'],['Lights']]);
    const event={key:' ',stopPropagation:vi.fn()};nav.props.onKeyDown(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
