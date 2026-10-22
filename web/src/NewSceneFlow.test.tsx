import React, {type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NewSceneChooser, StaticSceneComposer} from './NewSceneFlow';
import {defaultFilmTextCard} from './filmTextCard';

const hooks = vi.hoisted(() => ({enabled: false, cursor: 0, values: [] as any[]}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual,
    useRef(initial: unknown) {if (!hooks.enabled) return actual.useRef(initial); return hooks.values[hooks.cursor++] ??= {current: initial};},
    useState(initial: unknown) {
      if (!hooks.enabled) return actual.useState(initial);
      const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (value: any) => {hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;}];
    },
    useEffect(effect: () => void, deps: unknown[]) {if (!hooks.enabled) actual.useEffect(effect, deps);},
  };
});
afterEach(() => {hooks.enabled = false; hooks.cursor = 0; hooks.values = [];});
const noop = () => {};
const base = {width: 1920, height: 1080, fps: 24, onSubmit: async () => {}, onCancel: noop};
function nodes(tree: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(tree).flatMap(node => React.isValidElement<any>(node) ? [node, ...nodes((node as ReactElement<any>).props.children)] : []);
}
function render(props: Parameters<typeof StaticSceneComposer>[0]) {hooks.enabled = true; hooks.cursor = 0; const tree = StaticSceneComposer(props); return {tree, elements: nodes(tree)};}

describe('One new-scene flow', () => {
  it('offers the two scene types before creating any content', () => {
    const html = renderToStaticMarkup(<NewSceneChooser onProduct={noop} onStatic={noop} onCancel={noop}/>);
    expect(html).toContain('Product shot'); expect(html).toContain('Static image / text'); expect(html).toContain('Cancel');
    expect(html).not.toContain('Add image');
    const empty = renderToStaticMarkup(<StaticSceneComposer {...base}/>);
    expect(empty).toContain('Static scene image'); expect(empty).toContain('disabled="">Add scene');
  });

  it('leaves scene data untouched until submit and keeps text available after a failed import', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Import unavailable'));
    const initial = {name: 'Intro', durationSeconds: 2.5, card: {...defaultFilmTextCard, text: 'Made with gesso'}};
    const props = {...base, initial, onSubmit, editing: true};
    let view = render(props);
    expect(onSubmit).not.toHaveBeenCalled();
    view.elements.find(node => node.props.className === 'new-scene-submit')!.props.onClick();
    await Promise.resolve(); await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({kind: 'text', name: 'Intro', durationSeconds: 2.5, card: initial.card});
    view = render(props);
    expect(view.elements.find(node => node.props.role === 'alert')!.props.children).toBe('Import unavailable');
    expect(view.elements.find(node => node.props['aria-label'] === 'Scene text')!.props.value).toBe('Made with gesso');
    expect(view.elements.find(node => node.props.className === 'new-scene-submit')!.props.disabled).toBe(false);
  });

  it('prevents duplicate submissions while leaving Cancel usable and isolates viewport keys', async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => {})), onCancel = vi.fn();
    const props = {...base, initial: {card: {...defaultFilmTextCard, text: 'A title'}}, onSubmit, onCancel};
    let view = render(props);
    const add = view.elements.find(node => node.props.className === 'new-scene-submit')!;
    add.props.onClick(); add.props.onClick();
    expect(onSubmit).toHaveBeenCalledOnce();
    view = render(props);
    expect(view.elements.find(node => node.props.className === 'new-scene-submit')!.props.disabled).toBe(true);
    const cancel = view.elements.find(node => node.type === 'button' && node.props.onClick === onCancel)!;
    expect(cancel.props.disabled).toBeUndefined(); cancel.props.onClick(); expect(onCancel).toHaveBeenCalledOnce();
    const stopPropagation = vi.fn();
    view.tree.props.onKeyDown({key: ' ', stopPropagation, defaultPrevented: false});
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
