export const productImportAccept = '.glb,.blend,.step,.stp,.iges,.igs,.stl,.obj,.ply';
export type ProductImportKind = 'glb' | 'blend' | 'cad' | 'mesh';
export type ProductSourceUp = 'z' | 'y';
export type ProductSourceUnits = '' | 'mm' | 'cm' | 'm' | 'in' | 'ft';

export type MaterialImportFallback = {name: string; reason: string; fix?: string; objects: string[]; objectCount?: number};

/** Import history stays with the product, including after the toast disappears. */
export function productMaterialFallbacks(metadata: any): MaterialImportFallback[] {
  const records = metadata?.blendImport?.materialFallbacks;
  if (!Array.isArray(records)) return [];
  return records.filter(record => typeof record?.name === 'string' && record.name.trim()
    && typeof record?.reason === 'string' && record.reason.trim()).map(record => ({
      name: record.name, reason: record.reason,
      ...(typeof record.fix === 'string' && record.fix.trim() ? {fix: record.fix} : {}),
      objects: Array.isArray(record.objects) ? record.objects.filter((name: unknown) => typeof name === 'string') : [],
      ...(Number.isSafeInteger(record.objectCount) && record.objectCount >= 0 ? {objectCount: record.objectCount} : {}),
    }));
}

export function productMaterialFallbackCount(metadata: any): number {
  const count = metadata?.blendImport?.materialFallbackCount;
  const recorded = productMaterialFallbacks(metadata).length;
  return Number.isSafeInteger(count) && count >= recorded ? count : recorded;
}

export function productImportKind(filename: string): ProductImportKind | null {
  const extension = filename.toLowerCase().split('.').at(-1);
  if (extension === 'glb' || extension === 'blend') return extension;
  if (['step', 'stp', 'iges', 'igs'].includes(extension ?? '')) return 'cad';
  if (extension === 'stl' || extension === 'obj' || extension === 'ply') return 'mesh';
  return null;
}

/** Unitless formats must never silently become a differently sized product. */
export function productImportSettings(filename: string, sourceUp: ProductSourceUp, sourceUnits: ProductSourceUnits): Record<string, string> {
  const kind = productImportKind(filename);
  if (!kind) throw new Error('Choose a GLB, Blender, STEP, IGES, STL, OBJ or PLY file.');
  if (kind === 'glb') return {};
  if (kind === 'blend') {
    if (!sourceUnits) return {};
    if (!['mm', 'cm', 'm', 'in', 'ft'].includes(sourceUnits)) throw new Error('Choose valid source units.');
    return {sourceUnits};
  }
  if (!['z', 'y'].includes(sourceUp)) throw new Error('Choose the source up axis.');
  if (kind === 'cad') return {sourceUp};
  if (!['mm', 'cm', 'm', 'in', 'ft'].includes(sourceUnits)) throw new Error('Choose the units used by this STL, OBJ or PLY file.');
  return {sourceUp, sourceUnits};
}

export function productImportNotice(filename: string, metadata: any): string {
  const kind = productImportKind(filename);
  const summary = kind === 'blend' ? 'Blender product imported at its saved frame.'
    : kind === 'cad' ? 'CAD imported using its file units and hierarchy where provided.'
    : kind === 'mesh' ? `${filename.toLowerCase().split('.').at(-1)?.toUpperCase()} geometry imported using the selected units.`
    : 'Product geometry and supported materials imported.';
  const warnings = metadata?.[kind === 'blend' ? 'blendImport' : kind === 'cad' ? 'cadImport' : 'meshImport']?.warnings;
  const density = metadata?.importDiagnostics?.warnings;
  return [summary, ...[warnings, density].flatMap(list => Array.isArray(list) ? list.filter((warning: unknown) => typeof warning === 'string') : [])].join(' ');
}
