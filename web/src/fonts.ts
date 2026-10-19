import regular from './assets/OpenSans-Regular.woff?url';
import semibold from './assets/OpenSans-Semibold.woff?url';

// Load packaged bytes before measuring label artwork. No host font installation
// or third-party font server is needed for product artwork and canvas labels.
export async function loadStudioFonts() {
  await Promise.all([[regular, '400'], [semibold, '600']].map(async ([url, weight]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load the packaged studio font');
    const face = new FontFace('Studio Sans', await response.arrayBuffer(), {weight});
    document.fonts.add(await face.load());
  }));
}

// The Figma system uses both optical families in Regular and Medium.
// Keep font failures inspectable rather than silently claiming Halyard loaded.
export async function loadInterfaceFonts() {
  const requested = [
    '400 16px "Halyard Text"', '500 14px "Halyard Text"',
    '400 40px "Halyard Display"', '500 64px "Halyard Display"',
  ];
  const results = await Promise.allSettled(requested.map(font => document.fonts.load(font)));
  const missing = requested.filter((_, index) => {
    const result = results[index];
    return result.status === 'rejected' || result.value.length === 0 || result.value.some(face => face.status !== 'loaded');
  });
  document.documentElement.dataset.gessoFonts = missing.length ? 'fallback' : 'halyard';
  if (missing.length) console.warn('Halyard is unavailable to this browser. Activate the local fonts or configure a licensed web font source.', missing);
  await document.fonts.ready;
}
