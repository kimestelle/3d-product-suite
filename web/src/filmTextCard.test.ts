import {afterEach, describe, expect, it, vi} from 'vitest';
import {defaultFilmTextCard, drawFilmTextCard, isFilmTextCard, layoutFilmText, validateFilmTextCard} from './filmTextCard';

const card = {...defaultFilmTextCard, text: 'A product.\nAnother perspective.'};
const measure = (text: string, size: number) => [...text].length * size * .52;
afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});

describe('Film text card layout', () => {
  it('keeps explicit line breaks and fits measured lines inside the same output bounds', () => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
      const layout = layoutFilmText(card.text, width, height, measure);
      expect(layout.lines[0]).toBe('A product.');
      expect(layout.lines.join(' ')).toBe('A product. Another perspective.');
      expect(layout.lines.every(line => measure(line, layout.fontSize) <= width * .8)).toBe(true);
      expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(height * .8);
      expect(layout.x).toBe(width / 2);
    }
  });

  it('wraps an unbroken name without splitting a grapheme and refuses clipped output', () => {
    const word = '👩‍🎨'.repeat(18), layout = layoutFilmText(word, 100, 200, text => [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)].length * 15);
    expect(layout.lines.join('')).toBe(word);
    expect(layout.lines.every(line => line.endsWith('👩‍🎨'))).toBe(true);
    expect(() => layoutFilmText('line\n'.repeat(100), 1920, 1080, measure)).toThrow('too long');
  });

  it('validates persisted metadata and refuses oversized raster allocations', () => {
    expect(isFilmTextCard(card)).toBe(true);
    for (const value of [null, {}, {...card, version: 2}, {...card, text: ''}, {...card, text: 'x'.repeat(601)}, {...card, color: 'url(file)'}]) expect(isFilmTextCard(value)).toBe(false);
    expect(() => validateFilmTextCard({...card, text: 'x'.repeat(601)})).toThrow('600');
    expect(() => layoutFilmText('hello', 8193, 1080, measure)).toThrow('8192');
    expect(() => layoutFilmText('hello', 8192, 8192, measure)).toThrow('24 megapixels');
  });

  it('uses identical text layout for the reduced preview and full-resolution output', () => {
    const context = {font: '', scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText(text: string) {return {width: measure(text, Number(this.font.split(' ')[1].replace('px', '')))};}};
    const canvas = {width: 0, height: 0, getContext: () => context} as unknown as HTMLCanvasElement;
    const preview = drawFilmTextCard(canvas, card, 1920, 1080, true);
    expect(canvas.width).toBe(640); expect(canvas.height).toBe(360);
    const full = drawFilmTextCard(canvas, card, 1920, 1080);
    expect(canvas.width).toBe(1920); expect(canvas.height).toBe(1080);
    expect(full).toEqual(preview);
  });

  it('waits for real Halyard before capturing a PNG, and rejects a missing font', async () => {
    const {renderFilmTextCard} = await import('./filmTextCard');
    const fonts = {load: vi.fn().mockResolvedValue([]), check: vi.fn().mockReturnValue(false)};
    const createElement = vi.fn(); vi.stubGlobal('document', {fonts, createElement});
    await expect(renderFilmTextCard(card, 1920, 1080)).rejects.toThrow('Halyard Text is unavailable');
    expect(createElement).not.toHaveBeenCalled();
    const blob = new Blob(['png'], {type: 'image/png'});
    const context = {font: '', scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({width: 100})};
    const canvas = {width: 0, height: 0, getContext: () => context, toBlob: vi.fn((callback: (blob: Blob) => void) => callback(blob))};
    fonts.load.mockResolvedValue([{}]); fonts.check.mockReturnValue(true); createElement.mockReturnValue(canvas);
    await expect(renderFilmTextCard(card, 1920, 1080)).resolves.toBe(blob);
    expect(fonts.load).toHaveBeenCalledWith('400 16px "halyard-text-variable", "Halyard Text"');
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(canvas.width).toBe(1920); expect(canvas.height).toBe(1080);
  });
});
