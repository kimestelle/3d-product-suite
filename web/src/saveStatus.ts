export type SaveStatus = 'opening' | 'saving' | 'working' | 'unsaved' | 'saved';

/** Only a revision request is saving; other in-flight work keeps a neutral status. */
export function resolveSaveStatus({saving, loaded, busy, dirty}: {
  saving: boolean; loaded: boolean; busy: boolean; dirty: boolean;
}): SaveStatus {
  if (saving) return 'saving';
  if (!loaded) return 'opening';
  if (busy) return 'working';
  return dirty ? 'unsaved' : 'saved';
}
