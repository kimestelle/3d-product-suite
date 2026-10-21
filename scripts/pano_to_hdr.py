"""Convert a World Labs panorama PNG into a Radiance RGBE HDRI for scene lighting.

The provider panorama is an LDR sRGB image. Linearize it and expand the
highlights with a smooth inverse tone curve so bright apertures and lamps read
as light sources, then write 32-bit RLE RGBE that film.polyhaven.validate_hdri
accepts (4096 x 2048 maximum, -Y +X orientation).
"""
import argparse
import hashlib
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from film.polyhaven import validate_hdri  # noqa: E402


def rgbe_rows(linear):
    height, width, _ = linear.shape
    out = bytearray(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n" + f"-Y {height} +X {width}\n".encode())
    maximum = linear.max(axis=2)
    exponent = np.zeros(maximum.shape, dtype=np.int32)
    mantissa = np.zeros(maximum.shape, dtype=np.float64)
    nonzero = maximum > 1e-32
    mantissa[nonzero], exponent[nonzero] = np.frexp(maximum[nonzero])
    scale = np.where(nonzero, mantissa * 256.0 / np.where(nonzero, maximum, 1.0), 0.0)
    rgb = np.clip(np.floor(linear * scale[..., None]), 0, 255).astype(np.uint8)
    e = np.where(nonzero, exponent + 128, 0).astype(np.uint8)
    pixels = np.concatenate([rgb, e[..., None]], axis=2)
    for row in range(height):
        out += b"\x02\x02" + width.to_bytes(2, "big")
        for channel in range(4):
            column = pixels[row, :, channel]
            position = 0
            while position < width:
                run = min(128, width - position)
                out.append(run)
                out += column[position:position + run].tobytes()
                position += run
    return bytes(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pano", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--width", type=int, default=2048)
    parser.add_argument("--highlight-gain", type=float, default=6.0, help="Extra multiplier reached by the brightest pixels")
    parser.add_argument("--exposure", type=float, default=1.0)
    args = parser.parse_args()
    image = Image.open(args.pano).convert("RGB")
    image = image.resize((args.width, args.width // 2), Image.LANCZOS)
    srgb = np.asarray(image, dtype=np.float64) / 255.0
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    luminance = 0.2126 * linear[..., 0] + 0.7152 * linear[..., 1] + 0.0722 * linear[..., 2]
    boost = 1.0 + (args.highlight_gain - 1.0) * np.clip(luminance, 0, 1) ** 3
    linear = linear * boost[..., None] * args.exposure
    payload = rgbe_rows(linear)
    validate_hdri(payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    print(f"{args.output} {len(payload)} bytes sha256 {hashlib.sha256(payload).hexdigest()} max linear {linear.max():.2f}")


if __name__ == "__main__":
    main()
