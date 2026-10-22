"""Convert a local Blender document into gesso's static product handoff.

The source is opened in a separate Blender process with file scripts disabled.
Only a validated, self-contained GLB is published to the requested destination.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from .products import inspect_product_glb

MAX_BLEND_BYTES = 128 * 1024 * 1024
MAX_PRODUCT_BYTES = 128 * 1024 * 1024
MAX_IMPORT_REPORT_BYTES = 1024 * 1024
CONVERSION_TIMEOUT_SECONDS = 180
IMPORT_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "import_blend_product.py"


def convert_blend_product(source_path, output_path, *, blender="blender", source_units=None):
    """Return import metadata after writing a normalized static GLB.

    Failures raise ValueError and leave any existing destination untouched. The
    saved active scene and saved frame are authoritative; this is not a native
    Blender scene editor or simulation importer. Supported surface inputs are
    converted to static material maps in the isolated process.
    """
    source, destination = Path(source_path).resolve(), Path(output_path).resolve()
    if source_units is not None and (not isinstance(source_units, str) or source_units not in {"mm", "cm", "m", "in", "ft"}):
        raise ValueError("Blender units override must be mm, cm, m, in, or ft; omit it to use file units")
    if source.suffix.lower() != ".blend":
        raise ValueError("Blender product import requires a .blend file")
    if destination.suffix.lower() != ".glb" or source == destination:
        raise ValueError("Blender product conversion requires a separate .glb output")
    if not source.is_file():
        raise ValueError("Blender product file was not found; choose a saved .blend file")
    if not 0 < source.stat().st_size <= MAX_BLEND_BYTES:
        raise ValueError("Blender product files must be nonempty and no larger than 128 MiB")
    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    executable = os.fspath(blender) if blender else "blender"
    with tempfile.TemporaryDirectory(prefix="gesso-blend-") as temporary:
        temporary = Path(temporary)
        converted, report_path = temporary / "product.glb", temporary / "report.json"
        command = [executable, "--background", "--factory-startup", "--disable-autoexec",
                   "--python-exit-code", "1", "--python", str(IMPORT_SCRIPT), "--",
                   "--input", str(source), "--output", str(converted), "--report", str(report_path)]
        if source_units is not None:
            command.extend(["--source-units", source_units])
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    timeout=CONVERSION_TIMEOUT_SECONDS, check=False)
        except FileNotFoundError as error:
            raise ValueError("Blender is required to import .blend files; install Blender and configure the server's --blender executable") from error
        except subprocess.TimeoutExpired as error:
            raise ValueError("Blender import exceeded 180 seconds; simplify or bake the product's modifiers, then save and try again") from error
        except OSError as error:
            raise ValueError("Blender could not start; check the configured --blender executable and its permissions") from error
        report = None
        if report_path.is_file() and report_path.stat().st_size <= MAX_IMPORT_REPORT_BYTES:
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        if result.returncode != 0:
            message = report.get("error") if isinstance(report, dict) else None
            raise ValueError(message[:1600] if isinstance(message, str) and message else
                             "Blender could not read this product; open it in the configured Blender version, pack its resources, and save a new .blend file")
        if not isinstance(report, dict) or report.get("error") or not converted.is_file():
            raise ValueError("Blender did not produce a complete product; reopen the file, save it, and try again")
        if not 0 < converted.stat().st_size <= MAX_PRODUCT_BYTES:
            raise ValueError("Converted product exceeds the 128 MiB limit; reduce geometry or texture resolution")
        payload = converted.read_bytes()
        inspect_product_glb(payload)
        if hashlib.sha256(source.read_bytes()).hexdigest() != source_digest:
            raise ValueError("The Blender file changed during import; save it and import again")
        report["sourceSha256"] = source_digest
        # Publish only after validation. A failed conversion never replaces a
        # previous good file, even when the caller reuses an output pathname.
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = None
        try:
            with tempfile.NamedTemporaryFile("wb", prefix=".blend-import-", dir=destination.parent, delete=False) as handle:
                staging = Path(handle.name)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(staging, destination)
        finally:
            if staging is not None:
                staging.unlink(missing_ok=True)
        return report
