import React, {type ReactElement, type ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {useFilmEdits} from './FilmWorkspaceShared';
import FilmPanel from './FilmPanel';
import CameraPanel from './CameraPanel';
import WorldPanel from './WorldPanel';
import WorldObjectEditor from './WorldObjectEditor';
import KeyframeEditor from './KeyframeEditor';
import {addProp} from './world';
import {upsertKey} from './keyframes';

// Run real handlers with retained hook state, as in FilmShotStrip's tests.
const hooks = vi.hoisted(() => ({cursor: 0, values: [] as any[]}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual,
    useRef: (initial: unknown) => hooks.values[hooks.cursor++] ??= {current: initial},
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (value: any) => {hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;}];
    },
    useEffect: () => {}, useLayoutEffect: () => {}, useMemo: (factory: () => unknown) => factory(),
  };
});
afterEach(() => {hooks.cursor = 0; hooks.values = [];});
function nodes(tree: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(tree).flatMap(node => React.isValidElement<any>(node) ? [node, ...nodes((node as ReactElement<any>).props.children)] : []);
}
function render(component: () => ReactNode) {hooks.cursor = 0; return nodes(component());}
function button(elements: ReactElement<any>[], text: string) {
  const found = elements.find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  expect(found, text).toBeDefined(); return found!;
}

describe('Rejected edits retain the current selection and frame', () => {
  it('returns no film draft after rejection but preserves void callback acceptance', () => {
    const scene = structuredClone(fixture), before = structuredClone(scene), reject = vi.fn(() => false);
    const {edit} = useFilmEdits({scene, onChange: reject});
    expect(edit(draft => {draft.shots[0].name = 'Rejected'; return 'new-motion';})).toBeUndefined();
    expect(reject).toHaveBeenCalledOnce(); expect(scene).toEqual(before);
    hooks.cursor = 0;
    const accepted = useFilmEdits({scene, onChange: () => {}}).edit(draft => {draft.shots[0].name = 'Accepted'; return 'selected';});
    expect(accepted?.value).toBe('selected'); expect(accepted?.draft.shots[0].name).toBe('Accepted');
  });
  it('does not seek after a refused film frame-rate edit', () => {
    const scene = structuredClone(fixture), onFrame = vi.fn(), onChange = vi.fn(() => false);
    const elements = render(() => FilmPanel({scene, frame: 40, outputOnly: true, onChange, onFrame}));
    elements.find(node => node.props['aria-label'] === 'Frame rate')!.props.onChange({target: {value: '60'}});
    expect(onChange).toHaveBeenCalledOnce(); expect(onFrame).not.toHaveBeenCalled();
    expect(scene.render.fps).toBe(fixture.render.fps);
  });
  it('does not reset inspection or seek after a refused lens change', () => {
    const scene = structuredClone(fixture), onFrame = vi.fn(), onResetView = vi.fn(), onChange = vi.fn(() => false);
    const elements = render(() => CameraPanel({scene, frame: 1, onChange, onFrame, onResetView}));
    elements.find(node => node.props.ariaLabel === 'Focal length')!.props.onChange(85);
    expect(onChange).toHaveBeenCalledOnce(); expect(onFrame).not.toHaveBeenCalled(); expect(onResetView).not.toHaveBeenCalled();
  });
  it('does not select a world object that was never added', () => {
    const scene = structuredClone(fixture), onSelectObject = vi.fn(), onChange = vi.fn(() => false);
    const elements = render(() => WorldPanel({scene, layer: 'Props', worlds: [], onChange, onWorld: () => {}, onImport: () => {}, onSelectObject}));
    button(elements, 'Add box').props.onClick();
    expect(onChange).toHaveBeenCalledOnce(); expect(onSelectObject).not.toHaveBeenCalled();
  });
  it('keeps the object inspector open after a refused removal', () => {
    const scene: any = structuredClone(fixture), objectId = addProp(scene, 'box'), onClose = vi.fn(), onChange = vi.fn(() => false);
    const elements = render(() => WorldObjectEditor({scene, objectId, onChange, onClose}));
    button(elements, 'Remove object').props.onClick();
    expect(onChange).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
    expect(scene.environment.props.some((prop: any) => prop.id === objectId)).toBe(true);
  });
  it('restores the numeric key draft after its commit is refused', () => {
    const scene = structuredClone(fixture), reject = vi.fn(() => false);
    const elements = render(() => KeyframeEditor({scene, componentId: 'cap', frame: 1, onChange: reject, onFrame: () => {}, playing: false, onPlay: () => {}}));
    const field = elements.find(node => node.props.label === 'Cap Position X')!;
    const ValueField = field.type as (props: any) => ReactElement<any>;
    hooks.values = [];
    let input = render(() => ValueField(field.props))[0];
    input.props.onFocus(); input.props.onChange({target: {value: '50'}});
    input = render(() => ValueField(field.props))[0]; input.props.onBlur();
    input = render(() => ValueField(field.props))[0];
    expect(reject).toHaveBeenCalledOnce(); expect(input.props.value).toBe(String(field.props.value));
  });

  it('keeps a key selected at its original frame after a refused keyboard move', () => {
    const scene = structuredClone(fixture); upsertKey(scene, 'cap', 'position.x', 1, 0); upsertKey(scene, 'cap', 'position.x', 30, .02);
    const onChange = vi.fn(() => false), onFrame = vi.fn();
    const props = {scene, componentId: 'cap', frame: 30, onChange, onFrame, playing: false, onPlay: () => {}};
    let elements = render(() => KeyframeEditor(props));
    let key = elements.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('Cap Position X, frame 30,'))!;
    key.props.onClick({detail: 0}); onFrame.mockClear();
    elements = render(() => KeyframeEditor(props));
    key = elements.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('Cap Position X, frame 30,'))!;
    key.props.onKeyDown({key: 'ArrowRight', preventDefault: vi.fn(), altKey: false, metaKey: false, ctrlKey: false, shiftKey: false});
    expect(onChange).toHaveBeenCalledOnce(); expect(onFrame).not.toHaveBeenCalled();
    elements = render(() => KeyframeEditor(props));
    expect(elements.find(node => node.props.label === 'Selected key frame')?.props.value).toBe(30);
  });
});
