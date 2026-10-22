/** Editing previews have a bounded framebuffer; exported stills use their own resolution. */
export const PREVIEW_MAX_EDGE = 1280;
export const PREVIEW_MAX_PIXELS = 1280 * 720;

export interface PreviewResolution {
  width: number;
  height: number;
  pixelRatio: number;
}

/** Scale both axes together. Width/height describe the rounded GPU buffer, not
 * the CSS viewport or camera aspect, which must retain the measured layout. */
export function previewResolution(width: number, height: number, devicePixelRatio = 1): PreviewResolution {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const deviceRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  let pixelRatio = Math.min(1, deviceRatio, PREVIEW_MAX_EDGE / Math.max(safeWidth, safeHeight));
  // Apply the edge limit first so even very large input measurements cannot
  // overflow the area calculation.
  const pixels = (safeWidth * pixelRatio) * (safeHeight * pixelRatio);
  if (pixels > PREVIEW_MAX_PIXELS) pixelRatio *= Math.sqrt(PREVIEW_MAX_PIXELS / pixels);
  return {
    width: Math.max(1, Math.floor(safeWidth * pixelRatio)),
    height: Math.max(1, Math.floor(safeHeight * pixelRatio)),
    pixelRatio,
  };
}
