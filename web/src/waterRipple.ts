import {DataTexture, LinearFilter, RGBAFormat, UnsignedByteType} from 'three';

export type WaterRippleSettings = {strength: number; scale: number; speed: number};

const size = 128;

/** A spot's projection spans [-1, 1] in both light-local axes. Keep these
 * carriers in sync with the Cycles spotlight shader. The mask is light-linear. */
function writeMask(data: Uint8Array, strength: number, scale: number, t: number): void {
  const xCoords = Array.from({length: size}, (_, i) => ((i + .5) / size * 2 - 1) * scale);
  const bCols = xCoords.map(x => -.78 * x + 1.25 * Math.sin(.64 * x - .79 * t) - .72 * t);
  for (let row = 0, index = 0; row < size; row++) {
    const y = xCoords[row];
    const aRow = .58 * y + 1.40 * Math.sin(.70 * y + t) + t;
    const bRow = .94 * y;
    for (let col = 0; col < size; col++, index += 4) {
      const x = xCoords[col];
      const a = .5 + .5 * Math.sin(x + aRow);
      const b = .5 + .5 * Math.sin(bCols[col] + bRow);
      const c = .5 + .5 * Math.sin(.39 * x - 1.11 * y + 1.50 * Math.sin(.42 * (x + y) + .61 * t) + .46 * t);
      const ridge = Math.max(a, b, c);
      const value = Math.round(255 * (1 - strength + strength * (.16 + .84 * ridge ** 5)));
      data[index] = data[index + 1] = data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
}

/** One retained texture per active spot. Stepping back to the same sampled
 * time produces the same pixels, and still scenes spend no time animating. */
export class WaterRippleMap {
  private readonly data = new Uint8Array(size * size * 4);
  readonly texture = new DataTexture(this.data, size, size, RGBAFormat, UnsignedByteType);
  private strength = -1;
  private scale = -1;
  private phase = Number.NaN;

  constructor(private settings: WaterRippleSettings, timeSeconds: number) {
    this.texture.name = 'Water ripple · spot projection';
    this.texture.magFilter = this.texture.minFilter = LinearFilter;
    this.update(timeSeconds);
  }

  configure(settings: WaterRippleSettings, timeSeconds: number): void {
    this.settings = settings;
    this.update(timeSeconds);
  }

  update(timeSeconds: number): void {
    const {strength, scale, speed} = this.settings;
    const phase = timeSeconds * speed;
    if (strength === this.strength && scale === this.scale && phase === this.phase) return;
    writeMask(this.data, strength, scale, phase);
    this.strength = strength;
    this.scale = scale;
    this.phase = phase;
    this.texture.needsUpdate = true;
  }

  dispose(): void {this.texture.dispose();}
}
