import type {RandomSetupResult, RandomSetupSettings} from './randomSetup';

export type ExportDraft<T extends object = any> = {
  source: T;
  projectId: string;
  scene: T;
  seed: number;
  changes: string[];
  settings: RandomSetupSettings;
};

/** Retain the source identity while isolating every editable candidate value. */
export function createExportDraft<T extends object>(source: T, projectId: string, result: RandomSetupResult<T>, settings: RandomSetupSettings): ExportDraft<T> {
  return {source, projectId, scene: structuredClone(result.scene), seed: result.seed,
    changes: [...result.changes], settings: structuredClone(settings)};
}

/** A draft belongs to this exact revision, not merely to an equal scene or project name. */
export function currentExportDraft<T extends object>(draft: ExportDraft<T> | null, source: T | null, projectId: string | null | undefined): ExportDraft<T> | null {
  return draft && source && draft.source === source && draft.projectId === projectId ? draft : null;
}

/** Export controls edit the candidate; a changed project or revision invalidates it. */
export function editExportDraft<T extends object>(draft: ExportDraft<T> | null, source: T | null, projectId: string | null | undefined, edit: (scene: T) => void): ExportDraft<T> | null {
  const current = currentExportDraft(draft, source, projectId);
  if (!current) return null;
  const scene = structuredClone(current.scene);
  edit(scene);
  return {...current, scene};
}
