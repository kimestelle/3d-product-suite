/** Editorial grouping is independent of source geometry, transforms and actions. */
export interface HierarchyPart {
  id: string;
  componentId: string;
  name: string;
  parentId: string | null;
  source: 'scene' | 'glb';
  sourceName: string;
  sourcePath?: string;
  dimensionsM?: [number, number, number];
  materialSlots?: {id: string; name: string}[];
}
export type GroupingStatus = 'source' | 'suggested' | 'confirmed' | 'edited';
export interface Grouping { parentId: string | null; status: GroupingStatus }
export interface EditorHierarchy {
  version: 1;
  overrides: Record<string, {parentId: string | null; status: Exclude<GroupingStatus, 'source'>}>;
}
export interface ResolvedHierarchy {
  parents: Record<string, string | null>;
  sourceParents: Record<string, string | null>;
  status: Record<string, GroupingStatus>;
  recovered: number;
}

export function partName(id: string): string {
  const names: Record<string, string> = {'bottle-body': 'Body', neck: 'Neck', cap: 'Cap', label: 'Label'};
  return Object.hasOwn(names, id) ? names[id] : id;
}

export const PART_NAME_LIMIT = 120;

/** Display aliases never replace stable IDs or names embedded in an import. */
export function displayPartName(scene: any, id: string, fallback?: string): string {
  const names=scene?.editorPartNames;
  const alias=names&&typeof names==='object'&&!Array.isArray(names)&&Object.hasOwn(names,id)?names[id]:undefined;
  if(typeof alias==='string'&&alias.trim()&&alias.length<=PART_NAME_LIMIT)return alias.trim();
  const component=scene?.product?.components?.find((item:any)=>item.id===id);
  return component?.name||component?.displayName||fallback||partName(id);
}

export function renamePart(scene:any, parts:HierarchyPart[], id:string, value:string):void {
  const part=parts.find(item=>item.id===id);
  if(!part||!scene?.product?.components?.some((component:any)=>component.id===part.componentId))
    throw new Error('This part is no longer available.');
  const name=value.trim();
  if(!name)throw new Error('Enter a part name.');
  if(name.length>PART_NAME_LIMIT)throw new Error(`Use ${PART_NAME_LIMIT} characters or fewer.`);
  const existing=scene.editorPartNames;
  const names=existing&&typeof existing==='object'&&!Array.isArray(existing)?{...existing}:{};
  if(displayPartName(scene,id,part.name)===name)return;
  names[id]=name;
  scene.editorPartNames=names;
}

export function sceneParts(scene: any): HierarchyPart[] {
  return (scene?.product?.components ?? []).map((component: any) => ({
    id: component.id, componentId: component.id, name: displayPartName(scene,component.id),
    parentId: null, source: 'scene', sourceName: component.id,
    dimensionsM: component.sizeM,
  }));
}

/** This one fixture rule demonstrates the review flow; it is not an LLM or CAD importer. */
export function canSuggestFixtureGrouping(scene: any, parts: HierarchyPart[]): boolean {
  const components = scene?.product?.components ?? [];
  return scene?.product?.provenance?.source === 'Synthetic rigid bottle; not manufacturer CAD or a validated real mechanism.'
    && components.length === 4
    && components.every((c: any) => ['bottle-body', 'neck', 'cap', 'label'].includes(c.id) && c.shape !== 'mesh')
    && scene?.product?.label?.componentId === 'label'
    && ['bottle-body', 'label'].every(id => parts.some(part => part.id === id));
}

function cyclic(parents: Record<string, string | null>, id: string, proposed: string | null): boolean {
  const seen = new Set([id]);
  let current = proposed;
  while (current !== null) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parents[current] ?? null;
  }
  return false;
}

export function resolveHierarchy(scene: any, parts: HierarchyPart[]): ResolvedHierarchy {
  const ids = new Set(parts.map(part => part.id));
  const sourceParents: Record<string, string | null> = Object.create(null);
  const status: Record<string, GroupingStatus> = Object.create(null);
  let recovered = 0;
  for (const part of parts) {
    sourceParents[part.id] = part.parentId && ids.has(part.parentId) && part.parentId !== part.id ? part.parentId : null;
    status[part.id] = 'source';
  }
  for (const part of parts) if (cyclic(sourceParents, part.id, sourceParents[part.id])) {
    sourceParents[part.id] = null;
    recovered++;
  }
  const parents = {...sourceParents};
  const metadata = scene?.editorHierarchy;
  const overrides = metadata === undefined && canSuggestFixtureGrouping(scene, parts)
    ? {label: {parentId: 'bottle-body', status: 'suggested'}}
    : metadata?.version === 1 && metadata.overrides && typeof metadata.overrides === 'object' && !Array.isArray(metadata.overrides)
      ? metadata.overrides : {};
  for (const [id, value] of Object.entries(overrides)) {
    const item = value as any;
    if (!ids.has(id) || !item || !['suggested', 'confirmed', 'edited'].includes(item.status)
      || !(item.parentId === null || typeof item.parentId === 'string' && ids.has(item.parentId))
      || cyclic(parents, id, item.parentId)) { recovered++; continue; }
    parents[id] = item.parentId;
    status[id] = item.status;
  }
  return {parents, sourceParents, status, recovered};
}

function storedHierarchy(resolved: ResolvedHierarchy): EditorHierarchy {
  const overrides: EditorHierarchy['overrides'] = Object.create(null);
  for (const [id, parentId] of Object.entries(resolved.parents)) {
    const status = resolved.status[id];
    if (status !== 'source') overrides[id] = {parentId, status};
  }
  return {version: 1, overrides};
}

export function parentCandidates(scene: any, parts: HierarchyPart[], id: string): HierarchyPart[] {
  const hierarchy = resolveHierarchy(scene, parts);
  return parts.filter(part => !cyclic(hierarchy.parents, id, part.id));
}

export function changeParent(scene: any, parts: HierarchyPart[], id: string, parentId: string | null): void {
  const hierarchy = resolveHierarchy(scene, parts);
  if (!Object.hasOwn(hierarchy.parents, id) || parentId !== null && !Object.hasOwn(hierarchy.parents, parentId)) throw new Error('This source object is no longer available.');
  if (cyclic(hierarchy.parents, id, parentId)) throw new Error('A part cannot contain itself or one of its parents.');
  hierarchy.parents[id] = parentId;
  hierarchy.status[id] = 'edited';
  scene.editorHierarchy = storedHierarchy(hierarchy);
}

export function keepGrouping(scene: any, parts: HierarchyPart[], id: string): void {
  const hierarchy = resolveHierarchy(scene, parts);
  if (hierarchy.status[id] !== 'suggested') return;
  hierarchy.status[id] = 'confirmed';
  scene.editorHierarchy = storedHierarchy(hierarchy);
}

export function restoreSourceHierarchy(scene: any): void {
  scene.editorHierarchy = {version: 1, overrides: {}};
}

export function suggestFixtureGrouping(scene: any, parts: HierarchyPart[]): void {
  if (!canSuggestFixtureGrouping(scene, parts)) return;
  const hierarchy = resolveHierarchy(scene, parts);
  // A new suggestion never replaces an accepted/user-edited relation.
  if (['confirmed', 'edited'].includes(hierarchy.status.label)) return;
  if (cyclic(hierarchy.parents, 'label', 'bottle-body')) return;
  hierarchy.parents.label = 'bottle-body';
  hierarchy.status.label = 'suggested';
  scene.editorHierarchy = storedHierarchy(hierarchy);
}

export function orderedParts(parts: HierarchyPart[], parents: Record<string, string | null>): {part: HierarchyPart; depth: number}[] {
  const result: {part: HierarchyPart; depth: number}[] = [];
  const visited = new Set<string>();
  const children = new Map<string | null, HierarchyPart[]>();
  for (const part of parts) {
    const parent = parents[part.id] ?? null;
    children.set(parent, [...(children.get(parent) ?? []), part]);
  }
  const pending = (children.get(null) ?? []).map(part => ({part, depth: 0})).reverse();
  while (pending.length) {
    const item = pending.pop()!;
    if (visited.has(item.part.id)) continue;
    visited.add(item.part.id); result.push(item);
    for (const child of [...(children.get(item.part.id) ?? [])].reverse()) pending.push({part: child, depth: item.depth + 1});
  }
  for (const part of parts) if (!visited.has(part.id)) result.push({part, depth: 0});
  return result;
}
