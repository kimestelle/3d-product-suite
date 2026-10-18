import regular from './assets/OpenSans-Regular.woff?url';
import semibold from './assets/OpenSans-Semibold.woff?url';

// Load packaged bytes before measuring label artwork. No host font installation
// or third-party font server is needed for the editor or its canvas labels.
export async function loadStudioFonts() {
  await Promise.all([[regular, '400'], [semibold, '600']].map(async ([url, weight]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load the packaged studio font');
    const face = new FontFace('Studio Sans', await response.arrayBuffer(), {weight});
    document.fonts.add(await face.load());
  }));
}

// Local Halyard is the interface face; product artwork keeps its packaged font.
export async function loadInterfaceFonts() {
  await Promise.allSettled([
    document.fonts.load('400 13px "Halyard Text"'),
    document.fonts.load('500 14px "Halyard Text"'),
    document.fonts.load('500 32px "Halyard Display"'),
  ]);
  await document.fonts.ready;
}
