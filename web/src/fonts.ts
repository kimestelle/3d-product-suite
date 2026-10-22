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

// The licensed Adobe kit supplies real variable weights on every device.
// Keep font failures inspectable rather than silently claiming Halyard loaded.
export async function loadInterfaceFonts() {
  const requested = [
    '400 16px "halyard-text-variable"', '500 14px "halyard-text-variable"',
    '600 20px "halyard-text-variable"', '400 13px "halyard-micro-variable"',
    '400 40px "halyard-display-variable"', '500 64px "halyard-display-variable"',
  ];
  const results = await Promise.allSettled(requested.map(font => document.fonts.load(font)));
  const missing = requested.filter((_, index) => {
    const result = results[index];
    return result.status === 'rejected' || result.value.length === 0 || result.value.some(face => face.status !== 'loaded');
  });
  document.documentElement.dataset.gessoFonts = missing.length ? 'fallback' : 'halyard';
  if (missing.length) console.warn('The Halyard web fonts could not load. Check the connection or Adobe Fonts kit; local and packaged fallback fonts remain available.', missing);
  await document.fonts.ready;
}
