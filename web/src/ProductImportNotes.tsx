import {productMaterialFallbacks, productMaterialFallbackCount} from './productImport';
import './product-import-notes.css';

export default function ProductImportNotes({metadata}: {metadata: unknown}) {
  const materials = productMaterialFallbacks(metadata);
  if (!materials.length) return null;
  const count = productMaterialFallbackCount(metadata);
  return <details className="gesso-disclosure product-import-notes">
    <summary>Import notes <span>{count} {count === 1 ? 'material' : 'materials'} replaced</span></summary>
    <div className="product-import-notes-body">
      <p className="gesso-meta gesso-note">These materials were replaced with neutral surfaces on import. Assign replacements in Material.</p>
      <ul>{materials.map((material, index) => <li key={`${material.name}:${index}`}>
        <strong>{material.name}</strong>
        <p className="gesso-meta gesso-note">{material.reason}</p>
        {material.fix && <p className="gesso-meta gesso-note">To keep the original finish: {material.fix}</p>}
        {!!material.objects.length && <p className="gesso-meta">Objects: {material.objects.join(', ')}{(material.objectCount ?? 0) > material.objects.length ? ` + ${material.objectCount! - material.objects.length} more` : ''}</p>}
      </li>)}</ul>
      {count > materials.length && <p className="gesso-meta gesso-note">Showing the first {materials.length} of {count} replaced materials.</p>}
      <p className="gesso-meta gesso-note">The source file is unchanged.</p>
    </div>
  </details>;
}
