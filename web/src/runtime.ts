/** Build-time host configuration. Static demos never call the Python API. */
export const isStaticDemo = import.meta.env.VITE_STATIC_DEMO === '1';

/** Scene mutations need the evaluator, even when the existing film can replay offline. */
export const backendEditMessage = 'Editing needs a connected backend. The scene is unchanged.';

function relativePath(path: string): string {
  if (!path || /[\\:\0?#%]/.test(path) || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Expected a safe relative asset path.');
  }
  return path;
}

/** Resolve bundled data against Vite's base, including a GitHub Pages subpath. */
export function demoDataUrl(filename = 'bootstrap.json'): string {
  return `${import.meta.env.BASE_URL}demo/${relativePath(filename)}`;
}

/** Keep immutable asset references independent of their deployment host. */
export function assetUrl(assetPath: string): string {
  const path = relativePath(assetPath);
  return isStaticDemo ? demoDataUrl(path) : `/api/${path}`;
}
