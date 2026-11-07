import {Children, type ReactElement} from 'react';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addProp} from './world';
import {worldObjectTreeRows} from './WorldObjectTree';
import WorldProductEditor from './WorldProductEditor';
import {VectorControl} from './EditorControls';

describe('Stage scene objects', () => {
  it('shows every hidden object and nests product and props by saved placement dependencies', () => {
    const scene: any = structuredClone(fixture);
    scene.environment.plinth.visible = false;
    const id = addProp(scene, 'box');
    scene.environment.props[0].relationship = {type: 'beside', targetId: 'product'};
    scene.placement.scale = 2;
    const rows = worldObjectTreeRows(scene);
    expect(rows.map(row => row.id)).toEqual([scene.environment.plinth.id, '$product', id]);
    expect(rows.map(row => row.depth)).toEqual([0, 1, 2]);
    expect(rows[0].hidden).toBe(true);
    expect(rows[1].dimensionsM).toEqual(scene.product.dimensionsM.map((value: number) => value * 2));
    expect(rows[2].name).toBe(scene.environment.props[0].displayName);
    expect(rows[2].relationship).toBe('Beside Product');
  });

  it('keeps all objects discoverable when an old relationship has a missing target or cycle', () => {
    const scene: any = structuredClone(fixture);
    const first = addProp(scene, 'box');
    const second = addProp(scene, 'cylinder');
    scene.environment.props[0].relationship = {type: 'beside', targetId: second};
    scene.environment.props[1].relationship = {type: 'beside', targetId: first};
    const before = structuredClone(scene);
    expect(new Set(worldObjectTreeRows(scene).map(row => row.id)))
      .toEqual(new Set([scene.environment.plinth.id, '$product', first, second]));
    scene.environment.props[0].relationship.targetId = 'removed';
    expect(worldObjectTreeRows(scene)).toHaveLength(4);
    expect(before.environment.props[0].relationship.targetId).toBe(second);
  });

  it('editing a product dimension changes uniform Stage scale without changing its source geometry', () => {
    const scene: any = structuredClone(fixture);
    const originalProduct = structuredClone(scene.product);
    const editor = WorldProductEditor({scene, onChange: edit => edit(scene), onClose: () => {}, children: null});
    const body = (Children.toArray(editor.props.children) as ReactElement<any>[])
      .find(child => child.props.className === 'gesso-world-object-body')!;
    const section = (Children.toArray(body.props.children) as ReactElement<any>[])[0];
    const size = (Children.toArray(section.props.children) as ReactElement<any>[]).find(child => child.type === VectorControl)!;
    size.props.onChange(0, scene.product.dimensionsM[0] * 1.5);
    expect(scene.placement.scale).toBe(1.5);
    expect(scene.product).toEqual(originalProduct);
    expect(worldObjectTreeRows(scene).find(row => row.id === '$product')?.dimensionsM)
      .toEqual(scene.product.dimensionsM.map((value: number) => value * 1.5));
  });
});
