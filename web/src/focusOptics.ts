export type DepthOfFieldSample = {enabled: boolean; fStop: number; focusDistanceM: number};
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Preserve legacy sharp cameras; absent distance follows the sampled aim point. */
export function sampledDepthOfField(camera: any): DepthOfFieldSample {
  const focus = camera?.depthOfField;
  const distance = Array.isArray(camera?.positionM) && Array.isArray(camera?.targetM)
    ? Math.hypot(...camera.positionM.map((value: number, index: number) => value - camera.targetM[index])) : 1;
  const focusDistanceM = valid(focus?.focusDistanceM) && focus.focusDistanceM > 0 ? focus.focusDistanceM : distance;
  return {enabled: focus?.enabled === true && valid(focusDistanceM) && focusDistanceM > (camera?.focalLengthMm ?? 50) / 1000,
    fStop: valid(focus?.fStop) && focus.fStop >= .7 && focus.fStop <= 32 ? focus.fStop : 2.8,
    focusDistanceM: valid(focusDistanceM) && focusDistanceM > 0 ? focusDistanceM : 1};
}

/** Signed thin-lens circle-of-confusion diameter on the sensor, in millimetres. */
export function circleOfConfusionMm(depthM: number, focalLengthMm: number, focusDistanceM: number, fStop: number): number {
  const focalM = focalLengthMm / 1000;
  if (![depthM, focalLengthMm, focusDistanceM, fStop].every(Number.isFinite) || depthM <= 0 || focalM <= 0 || fStop <= 0 || focusDistanceM <= focalM) return 0;
  return 1000 * focalM * focalM * (depthM - focusDistanceM) / (fStop * depthM * (focusDistanceM - focalM));
}

export function circleOfConfusionRadiusPx(depthM: number, focalLengthMm: number, focusDistanceM: number, fStop: number, gateHeightPx: number): number {
  return Number.isFinite(gateHeightPx) && gateHeightPx > 0
    ? Math.abs(circleOfConfusionMm(depthM, focalLengthMm, focusDistanceM, fStop)) / 36 * gateHeightPx / 2 : 0;
}

/** Spark's native covariance blur uses the angle subtended by the aperture at the focus plane. */
export function sparkApertureAngle(focalLengthMm: number, focusDistanceM: number, fStop: number): number {
  const focalM = focalLengthMm / 1000;
  if (![focalLengthMm, focusDistanceM, fStop].every(Number.isFinite) || focalM <= 0 || fStop <= 0 || focusDistanceM <= focalM) return 0;
  return 2 * Math.atan(focalM / (2 * fStop * (focusDistanceM - focalM)));
}
