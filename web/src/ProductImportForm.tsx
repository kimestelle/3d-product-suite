import { useState } from 'react';

export const PRODUCT_MESH_MAX_BYTES = 128 * 1024 * 1024;
const formats = ['glb', 'obj', 'stl', 'ply'] as const;
type ProductMeshFormat = typeof formats[number];
type SourceUnits = '' | 'm' | 'cm' | 'mm' | 'in' | 'ft';
type SourceUp = '' | 'Y' | 'Z';
type MeshFile = Pick<File, 'name' | 'size'>;
export type ProductImportDraft = {
  name: string; owner: string; reuseBasis: string; source: string;
  file: MeshFile | null; units: SourceUnits; sourceUp: SourceUp;
};
export type ProductImportRequest = { file: File; query: URLSearchParams; normalized: boolean };

export function productMeshFormat(name: string): ProductMeshFormat | undefined {
  const extension = name.match(/\.([^.]+)$/)?.[1].toLowerCase();
  return formats.find(format => format === extension);
}

export function productMeshError(file: MeshFile | null, meshImportAvailable: boolean, units: SourceUnits, sourceUp: SourceUp): string {
  if (!file) return 'Choose a GLB, OBJ, STL, or PLY file.';
  const format = productMeshFormat(file.name);
  if (!format) return 'Use GLB, OBJ, STL, or PLY. Export native STEP / IGES CAD files to one of these mesh formats first.';
  if (!file.size) return 'The selected file is empty. Choose a mesh with geometry.';
  if (file.size > PRODUCT_MESH_MAX_BYTES) return 'The selected file exceeds the 128 MiB upload limit.';
  if (format === 'glb') return '';
  if (!meshImportAvailable) return 'OBJ, STL, and PLY imports require Blender 4.3.2 on the server. Install it and restart the app, or export a self-contained GLB in meters, Y-up and centered.';
  if (!units || !sourceUp) return 'Choose the source units and up axis used when exporting this mesh.';
  return '';
}

export function productImportError(draft: ProductImportDraft, meshImportAvailable: boolean): string {
  const meshError = productMeshError(draft.file, meshImportAvailable, draft.units, draft.sourceUp);
  if (meshError) return meshError;
  if (![draft.name, draft.owner, draft.reuseBasis, draft.source].every(value => value.trim())) {
    return 'Enter a product name, owner, source, and usage permission or license.';
  }
  return '';
}

export function productImportQuery(draft: ProductImportDraft, meshImportAvailable: boolean): URLSearchParams {
  const error = productImportError(draft, meshImportAvailable);
  if (error) throw new Error(error);
  const query = new URLSearchParams({
    name: draft.name.trim(), owner: draft.owner.trim(),
    reuseBasis: draft.reuseBasis.trim(), source: draft.source.trim(),
  });
  if (productMeshFormat(draft.file!.name) !== 'glb') {
    query.set('units', draft.units);
    query.set('sourceUp', draft.sourceUp);
  }
  return query;
}

export default function ProductImportForm({ meshImportAvailable, importing, onImport }: {
  meshImportAvailable: boolean; importing: boolean;
  onImport: (request: ProductImportRequest) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProductImportDraft>({ name: '', owner: '', reuseBasis: '', source: '', file: null, units: '', sourceUp: '' });
  const patch = (values: Partial<ProductImportDraft>) => setDraft(previous => ({ ...previous, ...values }));
  const format = draft.file && productMeshFormat(draft.file.name);
  const meshError = productMeshError(draft.file, meshImportAvailable, draft.units, draft.sourceUp);
  const error = productImportError(draft, meshImportAvailable);
  return <form className="import-form" onSubmit={event => {
    event.preventDefault();
    if (error || importing || !draft.file) return;
    void onImport({ file: draft.file as File, query: productImportQuery(draft, meshImportAvailable), normalized: format !== 'glb' });
  }}>
    <label className="field"><span>Product name</span><input required disabled={importing} value={draft.name} onChange={event => patch({ name: event.target.value })}/></label>
    <label className="field"><span>Product owner</span><input required disabled={importing} value={draft.owner} onChange={event => patch({ owner: event.target.value })}/></label>
    <label className="field"><span>Source URL or reference</span><input required disabled={importing} value={draft.source} onChange={event => patch({ source: event.target.value })}/></label>
    <label className="field"><span>Usage permission or license</span><input required disabled={importing} value={draft.reuseBasis} onChange={event => patch({ reuseBasis: event.target.value })}/></label>
    <p className="small-copy">Import a GLB, OBJ, STL, or PLY up to 128 MiB. Export CAD to one of these mesh formats; native STEP / IGES files are not supported yet.</p>
    <input aria-label="Product mesh file" type="file" accept=".glb,.obj,.stl,.ply" disabled={importing} onChange={event => patch({ file: event.target.files?.[0] ?? null, units: '', sourceUp: '' })}/>
    {format && format !== 'glb' && <>
      <label className="field"><span>Source units</span><select aria-label="Source units" required disabled={importing} value={draft.units} onChange={event => patch({ units: event.target.value as SourceUnits })}>
        <option value="">Choose source units</option><option value="m">Meters</option><option value="cm">Centimeters</option><option value="mm">Millimeters</option><option value="in">Inches</option><option value="ft">Feet</option>
      </select></label>
      <label className="field"><span>Source up axis</span><select aria-label="Source up axis" required disabled={importing} value={draft.sourceUp} onChange={event => patch({ sourceUp: event.target.value as SourceUp })}>
        <option value="">Choose up axis</option><option value="Y">Y up</option><option value="Z">Z up</option>
      </select></label>
      <p className="small-copy">The mesh will be converted to meters, made Y-up, and centered. OBJ must contain geometry only without an MTL reference; use an embedded GLB for textured assets. STL contains geometry only.</p>
    </>}
    {(!format || format === 'glb') && <p className="small-copy">GLB must be static and self-contained, in meters, Y-up, and centered at its bounding-box origin.</p>}
    {draft.file && meshError && <p className="message error" role="alert">{meshError}</p>}
    <button type="submit" disabled={!!error || importing}>{importing ? 'Importing…' : 'Import product'}</button>
  </form>;
}
