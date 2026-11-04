import {describe, expect, it} from 'vitest';
import {canApplyWorldCleanup, worldCleanupRenderScene} from './worldCleanupPreview';

describe('world cleanup preview ownership', () => {
  const scene = {environment:{asset:{sha256:'original'}},product:{id:'retained'}};
  const environment = {asset:{sha256:'repair'}};
  const owner = {source:scene,projectId:'campaign',environment,label:'Repair'};
  it('renders a separate environment without changing the canonical scene', () => {
    const preview = worldCleanupRenderScene(scene,'campaign',owner,true,'world','Environment');
    expect(preview?.environment).toBe(environment);
    expect(preview?.product).toBe(scene.product);
    expect(scene.environment.asset.sha256).toBe('original');
  });
  it('refuses stale source, campaign, navigation and inactive owners', () => {
    expect(worldCleanupRenderScene({...scene},'campaign',owner,true,'world','Environment')).toBeNull();
    expect(worldCleanupRenderScene(scene,'another',owner,true,'world','Environment')).toBeNull();
    expect(worldCleanupRenderScene(scene,'campaign',owner,true,'renders','Output')).toBeNull();
    expect(worldCleanupRenderScene(scene,'campaign',owner,false,'world','Environment')).toBeNull();
    expect(worldCleanupRenderScene<{environment:any;comparison?:unknown}>({...scene,comparison:{}},'campaign',owner,true,'world','Environment')).toBeNull();
  });
  it('applies only the exact visible candidate for its source owner', () => {
    expect(canApplyWorldCleanup(scene,'campaign',owner,environment)).toBe(true);
    expect(canApplyWorldCleanup(scene,'campaign',owner,{...environment})).toBe(false);
    expect(canApplyWorldCleanup({...scene},'campaign',owner,environment)).toBe(false);
    expect(canApplyWorldCleanup(scene,'another',owner,environment)).toBe(false);
  });
});
