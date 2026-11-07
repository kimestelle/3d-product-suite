import {UiIcon} from './UiIcon';
import {relationLabels, type RelationType} from './sceneGraph';
import './world-object-tree.css';

export interface WorldObjectTreeRow {
  id: string;
  name: string;
  kind: string;
  dimensionsM: number[];
  hidden: boolean;
  relationship?: string;
  parentId?: string;
  depth: number;
}

/** Placement dependencies determine ordering. Hidden objects remain inspectable. */
export function worldObjectTreeRows(scene: any): WorldObjectTreeRow[] {
  const environment = scene.environment;
  const plinth = environment.plinth;
  const props = environment.props ?? [];
  const productName = scene.product.displayName || 'Product';
  const targetId = (id: string | undefined) => id === 'product' ? '$product' : id;
  const names = new Map<string, string>([
    ['$product', productName], ['floor', 'Floor'], ['world-surface', 'Picked world surface'],
    [plinth.id, 'Plinth'],
    ...props.map((prop: any): [string, string] => [prop.id, prop.displayName ?? prop.name ?? prop.id]),
  ]);
  const support = targetId(scene.placement.restsOn ?? plinth.id);
  const entries: WorldObjectTreeRow[] = [
    {id: plinth.id, name: 'Plinth', kind: 'Contact surface', dimensionsM: plinth.sizeM,
      hidden: plinth.visible === false, depth: 0},
    ...props.map((prop: any): WorldObjectTreeRow => {
      const parentId = targetId(prop.relationship?.targetId);
      return {id: prop.id, name: names.get(prop.id)!,
        kind: prop.shape === 'mesh' ? 'Imported mesh' : prop.shape === 'cylinder' ? 'Cylinder' : 'Box',
        dimensionsM: prop.sizeM, hidden: prop.visible === false, parentId, depth: 0,
        relationship: parentId ? `${relationLabels[prop.relationship.type as RelationType] ?? prop.relationship.type} ${names.get(parentId) ?? parentId}` : undefined};
    }),
    {id: '$product', name: productName, kind: 'Product',
      dimensionsM: scene.product.dimensionsM.map((value: number) => value * (scene.placement.scale ?? 1)),
      hidden: false, parentId: support, relationship: `Rests on ${names.get(support!) ?? support}`, depth: 0},
  ];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const children = new Map<string, WorldObjectTreeRow[]>();
  for (const entry of entries) {
    if (!entry.parentId || !byId.has(entry.parentId) || entry.parentId === entry.id) continue;
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  const rows: WorldObjectTreeRow[] = [];
  const visited = new Set<string>();
  const append = (entry: WorldObjectTreeRow, depth: number) => {
    if (visited.has(entry.id)) return;
    visited.add(entry.id);
    rows.push({...entry, depth});
    for (const child of children.get(entry.id) ?? []) append(child, depth + 1);
  };
  for (const entry of entries) if (!entry.parentId || !byId.has(entry.parentId)) append(entry, 0);
  // A stale or cyclic saved relationship must never hide an object from recovery.
  for (const entry of entries) append(entry, 0);
  return rows;
}

export default function WorldObjectTree({scene, selectedId, onSelect}: {
  scene: any; selectedId?: string | null; onSelect: (id: string) => void;
}) {
  const rows = worldObjectTreeRows(scene);
  return <section className="gesso-section gesso-stage-scene-graph" aria-label="Scene graph">
    <div className="gesso-section-heading"><span className="gesso-section-label">Scene objects</span></div>
    <ul className="gesso-stage-object-tree gesso-selection-surface" aria-label="Scene objects">
      {rows.map(row => <li key={row.id} style={{paddingLeft: `${row.depth * 14}px`}}>
        <button type="button" data-object-id={row.id} aria-controls="world-object-settings"
          aria-label={`Edit ${row.name}`} aria-pressed={selectedId === row.id} onClick={() => onSelect(row.id)}>
          <span className="gesso-stage-object-icon"><UiIcon name={row.id === '$product' ? 'product' : row.hidden ? 'eyeoff' : 'part'} size={14}/></span>
          <span className="gesso-stage-object-copy">
            <span className="gesso-stage-object-name">{row.name}{row.hidden && <span>Hidden</span>}</span>
            <span className="gesso-stage-object-size">{row.kind} · {row.dimensionsM.map(value => Number((value * 1000).toFixed(1))).join(' × ')} mm</span>
            {row.relationship && <span className="gesso-stage-object-relation">{row.relationship}</span>}
          </span>
        </button>
      </li>)}
    </ul>
  </section>;
}
