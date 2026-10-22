import React, {type ReactElement, type ReactNode} from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import MaterialLibrary from './MaterialLibrary';
import MaterialAssignments from './MaterialAssignments';
import MaterialProperties from './MaterialProperties';
import MaterialSwatches from './MaterialSwatches';
import PartNameField from './PartNameField';
import ProductPanel from './ProductPanel';
import PartOptionsMenu from './PartOptionsMenu';
import {campaignMaterialPresets, materialStarters} from './materialPresets';
import {sceneParts} from './hierarchy';

// Exercise the real handlers with retained hook state in the Node test runner.
const hooks = vi.hoisted(() => ({cursor: 0, values: [] as any[]}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (value: any) => {hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;}];
    },
    useRef(initial: unknown) {return hooks.values[hooks.cursor++] ??= {current: initial};},
    useId() {return `guard-test-${hooks.cursor++}`;},
    useEffect() {}, useLayoutEffect() {},
  };
});
beforeEach(() => {hooks.cursor = 0; hooks.values = [];});
function render<T>(component: (props: T) => ReactNode, props: T) {hooks.cursor = 0; return component(props);}
function nodes(tree: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(tree).flatMap(node => React.isValidElement<any>(node) ? [node, ...nodes((node as ReactElement<any>).props.children)] : []);
}
function find(tree: ReactNode, predicate: (node: ReactElement<any>) => boolean) {
  const node = nodes(tree).find(predicate);
  if (!node) throw new Error('Expected control');
  return node;
}
const scene = structuredClone(fixture), parts = sceneParts(scene), presets = campaignMaterialPresets(scene);
const base = {scene, componentId: 'cap', parts, onSelect: vi.fn(), onChange: vi.fn(() => false)};

function openPreset(props: Parameters<typeof MaterialLibrary>[0]) {
  const tree = render(MaterialLibrary, props);
  find(tree, node => node.type === MaterialAssignments).props.onEdit(presets[0]);
  return render(MaterialLibrary, props);
}

describe('refused material and part edits', () => {
  it('lets people inspect a saved preset while refusing draft changes before preview', () => {
    const before = structuredClone(scene), onBeforeEdit = vi.fn(() => false), onChange = vi.fn(() => false);
    const props = {...base, onBeforeEdit, onChange};
    let tree = openPreset(props);
    expect(onBeforeEdit).not.toHaveBeenCalled();
    const name = find(tree, node => node.props['aria-label'] === 'Preset name').props.value;
    const material = find(tree, node => node.type === MaterialProperties).props.material;
    find(tree, node => node.props['aria-label'] === 'Preset name').props.onChange({target: {value: 'Changed'}});
    find(tree, node => node.type === MaterialProperties).props.onChange({...material, metallic: .83});
    find(tree, node => node.props['aria-label'] === 'Material type').props.onChange({target: {value: 'metal'}});
    tree = render(MaterialLibrary, props);
    expect(find(tree, node => node.props['aria-label'] === 'Preset name').props.value).toBe(name);
    expect(find(tree, node => node.type === MaterialProperties).props.material).toEqual(material);
    find(tree, node => node.props['aria-label'] === 'Cube sample').props.onClick();
    tree = render(MaterialLibrary, props);
    expect(find(tree, node => node.props['aria-label'] === 'Cube sample').props['aria-pressed']).toBe(true);
    expect(onBeforeEdit).toHaveBeenCalledTimes(3);
    expect(onChange).not.toHaveBeenCalled();
    expect(scene).toEqual(before);
  });

  it('does not create a draft or report saving, duplication or removal when refused', () => {
    const onBeforeEdit = vi.fn(() => false), onChange = vi.fn(() => false);
    const props = {...base, onBeforeEdit, onChange};
    let tree = render(MaterialLibrary, props);
    find(tree, node => node.type === MaterialSwatches).props.onSelect(materialStarters[0].id);
    tree = render(MaterialLibrary, props);
    expect(nodes(tree).some(node => node.props['aria-label'] === 'Preset name')).toBe(false);
    tree = openPreset(props);
    const assignment = find(tree, node => node.type === MaterialAssignments);
    assignment.props.onDuplicate(presets[0]);
    assignment.props.onDelete(presets[0]);
    find(tree, node => node.props.className === 'gesso-preset-save').props.onClick();
    tree = render(MaterialLibrary, props);
    expect(find(tree, node => node.props['aria-label'] === 'Preset name').props.value).toBe(presets[0].name);
    expect(nodes(tree).some(node => node.props['data-tone'] === 'success' && node.type === 'p')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not claim success when the final commit refuses an otherwise editable draft', () => {
    const props = {...base, onChange: vi.fn(() => false)};
    let tree = openPreset(props);
    find(tree, node => node.props['aria-label'] === 'Preset name').props.onChange({target: {value: 'Unsaved name'}});
    tree = render(MaterialLibrary, props);
    find(tree, node => node.props.className === 'gesso-preset-save').props.onClick();
    tree = render(MaterialLibrary, props);
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(nodes(tree).some(node => node.type === 'p' && node.props['data-tone'] === 'success')).toBe(false);
    expect(find(tree, node => node.props['aria-label'] === 'Preset name').props.value).toBe('Unsaved name');
  });

  it('restores the real object name after a refused rename', () => {
    const props = {name: 'Cap', inputRef: {current: null}, onCommit: vi.fn(() => false)};
    let tree = render(PartNameField, props);
    find(tree, node => node.type === 'input').props.onChange({target: {value: 'Wrong name'}});
    tree = render(PartNameField, props);
    find(tree, node => node.type === 'input').props.onBlur();
    tree = render(PartNameField, props);
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith('Wrong name');
    expect(find(tree, node => node.type === 'input').props.value).toBe('Cap');
  });

  it('keeps the selected object and skips removal feedback when removal is refused', () => {
    const props = {scene, parts, partId: 'cap', layer: 'Model' as const, onSelect: vi.fn(), onChange: vi.fn(() => false), onRemoved: vi.fn(),
      onLayer: vi.fn(), focused: true, onToggleFocus: vi.fn(), onFrame: vi.fn(), hiddenParts: [], onToggleVisibility: vi.fn(), onImport: vi.fn()};
    const tree = render(ProductPanel, props);
    find(tree, node => node.type === PartOptionsMenu && node.props.name === 'Cap').props.onRemove();
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRemoved).not.toHaveBeenCalled();
  });

  it('keeps attachment choices open and avoids a false assignment status', () => {
    const props = {scene, parts, presets, onSelect: vi.fn(), onEdit: vi.fn(), onChange: vi.fn(() => false)};
    const preset = presets[0];
    const subtree = () => find(render(MaterialAssignments, props), node => node.type === MaterialSwatches).props.renderBelow(preset);
    let tree = subtree();
    find(tree, node => node.props['aria-label'] === `Attach objects to ${preset.name}`).props.onClick();
    tree = subtree();
    find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({target: {checked: true}});
    tree = subtree();
    find(tree, node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children[0] === 'Attach').props.onClick();
    tree = subtree();
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(find(tree, node => node.props['aria-label'] === `Attach to ${preset.name}`)).toBeDefined();
    expect(find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.checked).toBe(true);
    const library = render(MaterialAssignments, props);
    expect(find(library, node => node.props.role === 'status').props.children).toBeUndefined();
  });
});
