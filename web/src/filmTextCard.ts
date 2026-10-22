export type FilmTextCard = {version: 1; text: string; color: string; background: string};
export const defaultFilmTextCard: FilmTextCard = {version: 1, text: '', color: '#ffffff', background: '#181818'};
export const filmTextLimit = 600;
export const filmTextFont = '"halyard-text-variable", "Halyard Text"';

export function isFilmTextCard(value: unknown): value is FilmTextCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as FilmTextCard;
  return card.version === 1 && typeof card.text === 'string' && !!card.text.trim() && card.text.length <= filmTextLimit &&
    [card.color, card.background].every(color => typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color));
}

export function validateFilmTextCard(card: FilmTextCard) {
  if (card.version !== 1 || typeof card.text !== 'string' || !card.text.trim()) throw new Error('Write some text for this scene.');
  if (card.text.length > filmTextLimit) throw new Error(`Keep the text within ${filmTextLimit} characters.`);
  if (![card.color, card.background].every(color => /^#[a-f0-9]{6}$/i.test(color))) throw new Error('Choose valid text and background colors.');
}

function checkSize(width: number, height: number) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) || width * height > 24 * 1024 * 1024)
    throw new Error('Use a frame within 8192 pixels per side and 24 megapixels.');
}

/** Measured once in output pixels; both the small preview and final PNG use it. */
export function layoutFilmText(text: string, width: number, height: number, measure: (text: string, size: number) => number) {
  checkSize(width, height);
  const marginX = width * .1, available = width - marginX * 2, maxHeight = height * .8;
  const maximum = Math.max(1, Math.min(width * .075, height * .15));
  const minimum = Math.min(maximum, Math.max(8, height * .025));
  const linesAt = (size: number) => {
    const lines: string[] = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (!paragraph.trim()) {lines.push(''); continue;}
      let line = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        const joined = line ? `${line} ${word}` : word;
        if (measure(joined, size) <= available) {line = joined; continue;}
        if (line) {lines.push(line); line = '';}
        // Long unbroken names or URLs still respect the frame's inner boundary.
        for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(word)) {
          if (line && measure(line + segment, size) > available) {lines.push(line); line = '';}
          line += segment;
          if (measure(line, size) > available) throw new Error('The text cannot fit this frame. Use a wider frame.');
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  // A fixed search is repeatable across preview scale and export resolution.
  let low = minimum, high = maximum;
  let lines = linesAt(low);
  if (lines.length * low * 1.2 > maxHeight) throw new Error('The text is too long for this frame. Shorten it or remove a line break.');
  for (let step = 0; step < 14; step++) {
    const size = (low + high) / 2, candidate = linesAt(size);
    if (candidate.length * size * 1.2 <= maxHeight) {low = size; lines = candidate;} else high = size;
  }
  const fontSize = low, lineHeight = fontSize * 1.2;
  return {fontSize, lineHeight, lines, x: width / 2, y: (height - lines.length * lineHeight) / 2 + lineHeight / 2};
}

let fontReady: Promise<void> | undefined;
export async function prepareFilmTextFont() {
  fontReady ??= (async () => {
    const faces = await document.fonts.load(`400 16px ${filmTextFont}`);
    if (!faces.length || !document.fonts.check(`400 16px ${filmTextFont}`)) throw new Error('Halyard Text is unavailable. Check the connection or enable the local font, then try again.');
  })().catch(error => {fontReady = undefined; throw error;});
  return fontReady;
}

export function drawFilmTextCard(canvas: HTMLCanvasElement, card: FilmTextCard, width: number, height: number, preview = false) {
  validateFilmTextCard(card); checkSize(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The text preview could not be created.');
  const scale = preview ? Math.min(1, 640 / Math.max(width, height)) : 1;
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const measure = (text: string, size: number) => {context.font = `400 ${size}px ${filmTextFont}`; return context.measureText(text).width;};
  const layout = layoutFilmText(card.text, width, height, measure);
  context.scale(canvas.width / width, canvas.height / height);
  context.fillStyle = card.background; context.fillRect(0, 0, width, height);
  context.font = `400 ${layout.fontSize}px ${filmTextFont}`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = card.color;
  layout.lines.forEach((line, index) => context.fillText(line, layout.x, layout.y + index * layout.lineHeight));
  return layout;
}

/** Canonical image upload makes live playback and export consume identical pixels. */
export async function renderFilmTextCard(card: FilmTextCard, width: number, height: number): Promise<Blob> {
  validateFilmTextCard(card); checkSize(width, height); await prepareFilmTextFont();
  const canvas = document.createElement('canvas');
  drawFilmTextCard(canvas, card, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The text image could not be saved.')), 'image/png'));
}
