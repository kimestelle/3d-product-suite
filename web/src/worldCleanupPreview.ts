export type WorldCleanupPreview = {environment: any; label: string};
export type WorldCleanupOwner<Scene> = WorldCleanupPreview & {source: Scene; projectId: string};

/** A world candidate is an editor view. It never becomes campaign history by
 * rendering, saving, navigating away or receiving a late analysis response. */
export function worldCleanupRenderScene<Scene extends {environment: any; comparison?: unknown}>(
  scene: Scene|null, projectId: string, owner: WorldCleanupOwner<Scene>|null,
  active: boolean, group: string, layer: string,
): Scene|null {
  if (!scene || !owner || owner.source !== scene || owner.projectId !== projectId
      || !active || group !== 'world' || layer !== 'Environment' || scene.comparison) return null;
  return {...scene, environment: owner.environment};
}

export function canApplyWorldCleanup<Scene>(source: Scene|null, projectId: string,
  owner: WorldCleanupOwner<Scene>|null, environment: unknown): boolean {
  return !!source && !!owner && owner.source === source && owner.projectId === projectId
    && owner.environment === environment;
}
