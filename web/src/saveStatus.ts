export type SaveStatus = 'opening' | 'saving' | 'working' | 'unsaved' | 'saved';
export type SavePreview = 'material' | 'film' | 'transform' | null;

/** Only a revision request is saving; other in-flight work keeps a neutral status. */
export function resolveSaveStatus({saving, loaded, busy, dirty}: {
  saving: boolean; loaded: boolean; busy: boolean; dirty: boolean;
}): SaveStatus {
  if (saving) return 'saving';
  if (!loaded) return 'opening';
  if (busy) return 'working';
  return dirty ? 'unsaved' : 'saved';
}

/** Persistence always belongs to the canonical campaign, never its local preview. */
export function saveStatusPresentation(status: SaveStatus, preview: SavePreview = null) {
  if (status === 'opening') return {label: 'Opening…', title: 'Opening campaign'};
  if (status === 'working') return {label: 'Working…', title: 'Operation in progress'};
  const labels = preview
    ? {saved: 'Original saved', saving: 'Saving original…', unsaved: 'Save original'}
    : {saved: 'Saved', saving: 'Saving…', unsaved: 'Save'};
  const titles = {saved: 'Campaign saved locally.', saving: 'Saving the campaign revision.', unsaved: 'Save campaign revision (⌘/Ctrl S).'};
  const previewNote = preview === 'material' ? ' The material preview is not included. Save the material first to include it.'
    : preview === 'film' ? ' The generated preview is not included. Use Keep film to apply it.'
    : preview === 'transform' ? ' The transform preview is not included. Apply or cancel it before saving.' : '';
  return {label: labels[status], title: titles[status] + previewNote};
}
