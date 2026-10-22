import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import FilmModeTabs from './FilmModeTabs';
import type {EditorMode} from './navigation';

function keyboard(mode: EditorMode, key: string) {
  const onMode = vi.fn(), focus = vi.fn(), querySelector = vi.fn(() => ({focus}));
  const tabs = FilmModeTabs({mode, onMode}).props.children;
  const tab = tabs.find((item: any) => item.props['data-mode'] === mode)!;
  const event = {key, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {parentElement: {querySelector}}};
  tab.props.onKeyDown(event);
  return {onMode, focus, querySelector, event};
}

describe('shared film format tabs', () => {
  it.each(['still', 'video'] as const)('has one selected tab stop for controlled %s mode', mode => {
    const html = renderToStaticMarkup(<FilmModeTabs mode={mode} onMode={() => {}}/>);
    expect(html).toContain('role="tablist" aria-label="Film format" aria-orientation="horizontal"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain(`data-mode="${mode}" aria-selected="true" tabindex="0"`);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it.each([
    ['still', 'ArrowRight', 'video'], ['video', 'ArrowRight', 'still'],
    ['video', 'ArrowLeft', 'still'], ['still', 'ArrowLeft', 'video'],
    ['video', 'Home', 'still'], ['still', 'End', 'video'],
  ] as const)('%s %s activates and focuses %s', (mode, key, next) => {
    const result = keyboard(mode, key);
    expect(result.onMode).toHaveBeenCalledExactlyOnceWith(next);
    expect(result.querySelector).toHaveBeenCalledWith(`[data-mode="${next}"]`);
    expect(result.focus).toHaveBeenCalledOnce();
    expect(result.event.preventDefault).toHaveBeenCalledOnce();
    expect(result.event.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each([' ', 'Enter'])('preserves native %s activation without leaking into playback', key => {
    const result = keyboard('still', key);
    expect(result.onMode).not.toHaveBeenCalled();
    expect(result.event.preventDefault).not.toHaveBeenCalled();
    expect(result.event.stopPropagation).toHaveBeenCalledOnce();
    const onMode = vi.fn(), tabs = FilmModeTabs({mode: 'still', onMode}).props.children;
    tabs[1].props.onClick();
    expect(onMode).toHaveBeenCalledExactlyOnceWith('video');
  });

  it('leaves Tab available for exiting the control', () => {
    const result = keyboard('still', 'Tab');
    expect(result.onMode).not.toHaveBeenCalled();
    expect(result.event.preventDefault).not.toHaveBeenCalled();
    expect(result.event.stopPropagation).not.toHaveBeenCalled();
  });
});
