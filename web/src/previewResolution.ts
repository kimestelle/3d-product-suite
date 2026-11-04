/** Motion keeps a small framebuffer; settled inspection may spend more pixels.
 * Exported stills use their own resolution and bypass both live budgets. */
export const PREVIEW_MAX_EDGE = 1280;
export const PREVIEW_MAX_PIXELS = 1280 * 720;
export const PREVIEW_SETTLED_MAX_EDGE = 1920;
export const PREVIEW_SETTLED_MAX_PIXELS = 1920 * 1080;
export const PREVIEW_SETTLED_MAX_PIXEL_RATIO = 1.5;
export const PREVIEW_SETTLE_DELAY_MS = 180;

export type PreviewQuality = 'interactive' | 'settled';

export interface PreviewResolution {
  width: number;
  height: number;
  pixelRatio: number;
}

/** Scale both axes together. Width/height describe the rounded GPU buffer, not
 * the CSS viewport or camera aspect, which must retain the measured layout. */
export function previewResolution(width: number, height: number, devicePixelRatio = 1, quality: PreviewQuality = 'interactive'): PreviewResolution {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const deviceRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const settled = quality === 'settled';
  const maxEdge = settled ? PREVIEW_SETTLED_MAX_EDGE : PREVIEW_MAX_EDGE;
  const maxPixels = settled ? PREVIEW_SETTLED_MAX_PIXELS : PREVIEW_MAX_PIXELS;
  let pixelRatio = Math.min(settled ? PREVIEW_SETTLED_MAX_PIXEL_RATIO : 1, deviceRatio, maxEdge / Math.max(safeWidth, safeHeight));
  // Apply the edge limit first so even very large input measurements cannot
  // overflow the area calculation.
  const pixels = (safeWidth * pixelRatio) * (safeHeight * pixelRatio);
  if (pixels > maxPixels) pixelRatio *= Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(safeWidth * pixelRatio)),
    height: Math.max(1, Math.floor(safeHeight * pixelRatio)),
    pixelRatio,
  };
}

/** One delayed redraw after editing settles, rather than a continuous loop.
 * The callback should schedule a draw directly: recording it as new activity
 * would immediately undo the settled promotion. No renderer or asset ownership. */
export class PreviewQualityController {
  private current: PreviewQuality = 'interactive';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private playback = false;
  private suspended = false;
  private saveData = false;
  private disposed = false;

  constructor(private readonly onChange: (quality: PreviewQuality) => void) {}

  get quality(): PreviewQuality { return this.current; }

  /** Call for sampled frames, orbit/zoom, resize or a changed scene/control. */
  activity(): void {
    if (this.disposed) return;
    this.cancelPromotion();
    this.setQuality('interactive');
    if (this.playback || this.suspended || this.saveData) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (this.disposed || generation !== this.generation || this.playback || this.suspended || this.saveData) return;
      this.timer = null;
      this.setQuality('settled');
    }, PREVIEW_SETTLE_DELAY_MS);
  }

  /** Explicit transport state prevents promotion between slow sampled frames. */
  setPlayback(playing: boolean): void {
    if (this.disposed || this.playback === playing) return;
    this.playback = playing;
    this.activity();
  }

  /** Hidden/offscreen/loading/capture work must not leave an idle draw pending.
   * Preserve the last quality while paused; resuming begins a fresh idle delay. */
  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) this.cancelPromotion();
    else this.activity();
  }

  setSaveData(saveData: boolean): void {
    if (this.disposed || this.saveData === saveData) return;
    this.saveData = saveData;
    this.activity();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPromotion();
  }

  private setQuality(quality: PreviewQuality): void {
    if (quality === this.current) return;
    this.current = quality;
    this.onChange(quality);
  }

  private cancelPromotion(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
