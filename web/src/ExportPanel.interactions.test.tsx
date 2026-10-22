import React, {type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import ExportPanel, {type ExportPanelProps} from './ExportPanel';
import FilmModeTabs from './FilmModeTabs';
import type {ExportJob} from './exportModel';

// Drive the real panel handlers in the repository's Node-only test environment.
// The hook store preserves state across renders without duplicating panel logic.
const hooks = vi.hoisted(() => ({cursor: 0, values: [] as any[], dependencies: [] as unknown[][],
  effects: [] as (() => void)[], dirty: false}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (update: any) => {
        const next = typeof update === 'function' ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) {hooks.values[index] = next; hooks.dirty = true;}
      }];
    },
    useRef(initial: unknown) {const index = hooks.cursor++; return hooks.values[index] ??= {current: initial};},
    useId() {return `export-test-${hooks.cursor++}`;},
    useEffect(effect: () => void, dependencies: unknown[]) {
      const index = hooks.cursor++, previous = hooks.dependencies[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.dependencies[index] = dependencies; hooks.effects.push(effect);
      }
    },
  };
});

const queued: ExportJob = {id: 'render-1', kind: 'reel', format: 'mp4', filename: 'Lamp handoff', state: 'queued', completedFrames: 0, totalFrames: 360, artifacts: []};
const base: ExportPanelProps = {
  scene: {render: {width: 1080, height: 1920, fps: 24, samples: 32}, shots: [{endFrame: 360}]},
  projectName: 'Lamp campaign', frame: 125, initialMode: 'still', capabilities: {blenderAvailable: true, ffmpegAvailable: true}, jobs: [], currentDigest: 'current',
  onSubmit: async () => queued, onControl: async () => {}, onClose: () => {}, onAdjustFrame: () => {},
};
function render(props: ExportPanelProps) {
  let tree: ReactElement;
  do {
    hooks.cursor = 0; hooks.dirty = false; hooks.effects = [];
    tree = ExportPanel(props);
    for (const effect of hooks.effects) effect();
  } while (hooks.dirty);
  return tree;
}
function nodes(tree: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(tree).flatMap(node => React.isValidElement<any>(node) ? [node, ...nodes((node as ReactElement<any>).props.children)] : []);
}
function find(tree: ReactNode, predicate: (node: ReactElement<any>) => boolean) {
  const result = nodes(tree).find(predicate);
  if (!result) throw new Error('Expected panel control was not rendered');
  return result;
}
function button(tree: ReactNode, label: string) {return find(tree, node => node.type === 'button' && renderToStaticMarkup(node).includes(label));}
function submit(tree: ReactNode) {find(tree, node => node.type === 'form').props.onSubmit({preventDefault: vi.fn()});}
async function settle() {await Promise.resolve(); await Promise.resolve();}

beforeEach(() => {hooks.cursor = 0; hooks.values = []; hooks.dependencies = []; hooks.effects = []; hooks.dirty = false;});

describe('Export sidebar interactions', () => {
  it('switches mode without rendering, retains shared settings, and submits the selected video format', async () => {
    const onSubmit = vi.fn(async () => queued), onModeChange = vi.fn();
    const props = {...base, onSubmit, onModeChange};
    let tree = render(props);
    find(tree, node => node.type === 'input' && node.props.maxLength === 120).props.onChange({target: {value: 'Lamp handoff.mov'}});
    const selects = nodes(tree).filter(node => node.type === 'select');
    selects[0].props.onChange({target: {value: '.5'}});
    selects[1].props.onChange({target: {value: '128'}});
    find(tree, node => node.type === 'input' && node.props.value === 'jpeg').props.onChange();
    tree = render(props);
    find(tree, node => node.type === FilmModeTabs).props.onMode('video');
    tree = render({...props, initialMode: 'video'});
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith('video');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(find(tree, node => node.type === 'input' && node.props.value === 'mp4').props.checked).toBe(true);
    find(tree, node => node.type === 'input' && node.props.value === 'prores').props.onChange();
    tree = render({...props, initialMode: 'video'});
    submit(tree);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({kind: 'reel', format: 'prores', filename: 'Lamp handoff', frame: 125, width: 540, height: 960, samples: 128});
    await settle();
    expect(renderToStaticMarkup(render({...props, initialMode: 'video'}))).toContain('Waiting to render');
  });

  it('follows external mode changes without echoing them and adjusts the matching composition', () => {
    const onModeChange = vi.fn(), onAdjustFrame = vi.fn();
    const props = {...base, onModeChange, onAdjustFrame};
    render(props);
    const tree = render({...props, initialMode: 'video'});
    expect(find(tree, node => node.type === FilmModeTabs).props.mode).toBe('video');
    expect(renderToStaticMarkup(tree)).toContain('Render video');
    expect(onModeChange).not.toHaveBeenCalled();
    button(tree, 'Adjust framing').props.onClick();
    expect(onAdjustFrame).toHaveBeenCalledExactlyOnceWith('video');
  });

  it('keeps prerequisite validation at the actual submit boundary', () => {
    const onSubmit = vi.fn();
    const tree = render({...base, onSubmit, capabilities: {blenderAvailable: false}});
    expect(button(tree, 'Render still').props.disabled).toBe(true);
    submit(tree);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes on Escape while allowing main workspace shortcuts through', () => {
    const onClose = vi.fn(), stopPropagation = vi.fn();
    const tree = render({...base, onClose});
    const handleKey = (tree.props as {onKeyDown: (event: unknown) => void}).onKeyDown;
    handleKey({key: '1', altKey: true, stopPropagation});
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    handleKey({key: 'Escape', stopPropagation});
    expect(onClose).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('lets an open select consume Escape before closing the Export workspace', () => {
    const onClose = vi.fn(), stopPropagation = vi.fn();
    const tree = render({...base, onClose});
    const handleKey = (tree.props as {onKeyDown: (event: unknown) => void}).onKeyDown;
    const closest = vi.fn().mockReturnValueOnce({tagName: 'SELECT'}).mockReturnValue(null);
    const event = {key: 'Escape', stopPropagation, target: {closest}};
    handleKey(event);
    expect(closest).toHaveBeenLastCalledWith('select:open');
    expect(onClose).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    // Once the browser has closed the native picker, Escape can leave Export.
    handleKey(event);
    expect(onClose).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('does not switch back to an old mode when a pending submission finishes', async () => {
    let finish!: (job: ExportJob) => void;
    const props = {...base, onSubmit: vi.fn(() => new Promise<ExportJob>(resolve => {finish = resolve;}))};
    submit(render(props));
    let tree = render(props);
    find(tree, node => node.type === FilmModeTabs).props.onMode('video');
    finish({...queued, kind: 'still', format: 'png'});
    await settle();
    tree = render({...props, jobs: [{...queued, kind: 'still', format: 'png'}]});
    expect(renderToStaticMarkup(tree)).toContain('Render video');
    expect(renderToStaticMarkup(tree)).toContain('Previous exports');
  });

  it('returns from a selected job to the new source without losing export settings', async () => {
    const current = {}, candidate = {}, onSubmit = vi.fn(async () => queued);
    const props = {...base, previewSource: current, jobs: [queued], onSubmit};
    let tree = render(props);
    find(tree, node => node.type === 'input' && node.props.value === 'jpeg').props.onChange();
    const selects = nodes(tree).filter(node => node.type === 'select');
    selects[0].props.onChange({target: {value: '.5'}});
    selects[1].props.onChange({target: {value: '128'}});
    find(tree, node => node.type === 'input' && node.props.maxLength === 120).props.onChange({target: {value: 'Candidate detail'}});
    button(render(props), 'Lamp handoff').props.onClick();
    expect(renderToStaticMarkup(render(props))).toContain('Waiting to render');

    const next = {...props, previewSource: candidate, currentDigest: 'candidate', frame: 24,
      scene: {...base.scene, render: {...base.scene.render, width: 1920, height: 1080}}};
    tree = render(next);
    expect(button(tree, 'Render still').props.disabled).toBe(false);
    expect(nodes(tree).some(node => node.props['aria-label'] === 'Selected export')).toBe(false);
    expect(find(tree, node => node.type === 'input' && node.props.value === 'jpeg').props.checked).toBe(true);
    const nextSelects = nodes(tree).filter(node => node.type === 'select');
    expect(nextSelects.map(node => node.props.value)).toEqual([.5, 128]);
    expect(find(tree, node => node.type === 'input' && node.props.maxLength === 120).props.value).toBe('Candidate detail');
    expect(renderToStaticMarkup(tree)).toContain('Previous exports');
    submit(tree);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({kind: 'still', format: 'jpeg', filename: 'Candidate detail', frame: 24, width: 960, height: 540, samples: 128});
    await settle();
  });

  it('keeps a late successful render in history without replacing the new source controls', async () => {
    let finish!: (job: ExportJob) => void;
    const current = {}, candidate = {};
    const props = {...base, previewSource: current,
      onSubmit: vi.fn(() => new Promise<ExportJob>(resolve => {finish = resolve;}))};
    submit(render(props));
    const next = {...props, previewSource: candidate, currentDigest: 'candidate'};
    expect(button(render(next), 'Starting…').props.disabled).toBe(true);
    finish({...queued, kind: 'still', format: 'png', sourceDigest: 'current'});
    await settle();
    const tree = render({...next, jobs: [{...queued, kind: 'still', format: 'png', sourceDigest: 'current'}]});
    expect(button(tree, 'Render still').props.disabled).toBe(false);
    expect(nodes(tree).some(node => node.props['aria-label'] === 'Selected export')).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain('Previous exports');
    expect(button(tree, 'Lamp handoff')).toBeDefined();
  });

  it('ignores a previous source failure while reporting failures from the current source', async () => {
    let fail!: (error: Error) => void;
    const current = {}, candidate = {};
    const onSubmit = vi.fn<ExportPanelProps['onSubmit']>()
      .mockImplementationOnce(() => new Promise<ExportJob>((_resolve, reject) => {fail = reject;}))
      .mockRejectedValueOnce(new Error('Current candidate export failed'));
    const props = {...base, previewSource: current, onSubmit};
    submit(render(props));
    const next = {...props, previewSource: candidate, currentDigest: 'candidate'};
    render(next);
    fail(new Error('Previous source export failed'));
    await settle();
    let tree = render(next);
    expect(button(tree, 'Render still').props.disabled).toBe(false);
    expect(nodes(tree).filter(node => node.props.role === 'alert')).toHaveLength(0);
    expect(renderToStaticMarkup(tree)).not.toContain('Previous source export failed');
    submit(tree);
    await settle();
    tree = render(next);
    expect(renderToStaticMarkup(find(tree, node => node.props.role === 'alert'))).toContain('Current candidate export failed');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('keeps candidate output controls without offering to edit the original framing', () => {
    const tree = render({...base, previewSource: {}, onAdjustFrame: undefined,
      compositionSettings: <p>Candidate composition controls</p>});
    expect(nodes(tree).filter(node => node.type === 'button' && renderToStaticMarkup(node).includes('Adjust framing'))).toHaveLength(0);
    expect(renderToStaticMarkup(tree)).toContain('Candidate composition controls');
    expect(button(tree, 'Render still').props.disabled).toBe(false);
  });

  it('retains job controls, updated progress, downloads, and settings after starting again', async () => {
    const onControl = vi.fn(async () => {});
    let props = {...base, jobs: [queued], onControl};
    let tree = render(props);
    button(tree, 'Lamp handoff').props.onClick();
    tree = render(props);
    button(tree, 'Cancel render').props.onClick();
    expect(onControl).toHaveBeenLastCalledWith('render-1', 'cancel', undefined);
    await settle();
    props = {...props, jobs: [{...queued, state: 'interrupted', completedFrames: 20}]};
    tree = render(props);
    expect(renderToStaticMarkup(tree)).toContain('20 / 360 frames');
    button(tree, 'Resume render').props.onClick();
    expect(onControl).toHaveBeenLastCalledWith('render-1', 'resume', undefined);
    await settle();
    props = {...props, jobs: [{...queued, state: 'succeeded', completedFrames: 360, artifacts: [{name: 'film.mp4', url: '/api/exports/render-1/film.mp4', downloadName: 'Lamp handoff.mp4'}]}]};
    tree = render(props);
    expect(find(tree, node => node.type === 'a' && node.props.download === 'Lamp handoff.mp4').props.href).toBe('/api/exports/render-1/film.mp4?download=1');
    button(tree, 'New export').props.onClick();
    expect(renderToStaticMarkup(render(props))).toContain('Render still');
  });
});
