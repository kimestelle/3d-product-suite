/** Bar and beat positions on the film clock for a soundtrack with a known tempo. */
const BEATS_PER_BAR = 4;
const MAX_BAR_TICKS = 2000;
const MAX_BEAT_TICKS = 8000;

export const beatSeconds = (bpm: number) => 60 / bpm;
export const barSeconds = (bpm: number, beatsPerBar = BEATS_PER_BAR) => beatsPerBar * 60 / bpm;

const tidy = (value: number) => Number(value.toFixed(6));

/** Every grid line `offsetS + k·period` that lands inside [0, durationS]; empty when the grid is unusable or too dense. */
function gridTimes(period: number, offsetS: number, durationS: number, limit: number): number[] {
  if (!(period > 0) || !Number.isFinite(period) || !Number.isFinite(offsetS) || !(durationS >= 0)) return [];
  const epsilon = 1e-9;
  const first = Math.ceil((0 - offsetS) / period - epsilon), last = Math.floor((durationS - offsetS) / period + epsilon);
  if (last < first || last - first + 1 > limit) return [];
  const times: number[] = [];
  for (let k = first; k <= last; k++) times.push(tidy(offsetS + k * period));
  return times;
}

/** Bar starts (4 beats) anchored at the soundtrack offset, within the film's duration. */
export function barTimes(bpm: number, offsetS: number, durationS: number, beatsPerBar = BEATS_PER_BAR): number[] {
  return bpm > 0 && Number.isFinite(bpm) ? gridTimes(barSeconds(bpm, beatsPerBar), offsetS, durationS, MAX_BAR_TICKS) : [];
}

/** Every beat, including the bar starts. */
export function beatTimes(bpm: number, offsetS: number, durationS: number): number[] {
  return bpm > 0 && Number.isFinite(bpm) ? gridTimes(beatSeconds(bpm), offsetS, durationS, MAX_BEAT_TICKS) : [];
}

/** The nearest bar start to a film time, on the same anchored grid. */
export function snapToBar(timeS: number, bpm: number, offsetS: number, beatsPerBar = BEATS_PER_BAR): number {
  if (!(bpm > 0) || !Number.isFinite(bpm) || !Number.isFinite(timeS) || !Number.isFinite(offsetS)) return timeS;
  const period = barSeconds(bpm, beatsPerBar);
  return tidy(offsetS + Math.round((timeS - offsetS) / period) * period);
}
