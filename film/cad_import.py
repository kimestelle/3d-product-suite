"""Isolated STEP/IGES and OBJ/STL conversion to the shared static GLB handoff."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from .products import inspect_product_glb

CAD_EXTENSIONS = frozenset({".step", ".stp", ".iges", ".igs"})
MESH_EXTENSIONS = frozenset({".stl", ".obj"})
MESH_UNITS = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}
MAX_SOURCE_BYTES = MAX_PRODUCT_BYTES = 128 * 1024 * 1024
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

def _convert(source_path, output_path, *, extensions, command, arguments, timeout, worker):
    source, destination = Path(source_path).resolve(), Path(output_path).resolve()
    if source.suffix.lower() not in extensions:
        raise ValueError(f"{worker} import requires {", ".join(sorted(extensions))}")
    if destination.suffix.lower() != ".glb" or source == destination:
        raise ValueError("Product conversion requires a separate .glb output")
    if not source.is_file():
        raise ValueError("Product file was not found; choose a saved source file")
    if not 0 < source.stat().st_size <= MAX_SOURCE_BYTES:
        raise ValueError("Product files must be nonempty and no larger than 128 MiB")
    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="gesso-product-") as temporary:
        temporary = Path(temporary)
        converted, report_path = temporary / "product.glb", temporary / "report.json"
        argv = [*command, "--input", str(source), "--output", str(converted), "--report", str(report_path), *arguments]
        try:
            with (temporary / "worker.log").open("wb") as log:
                result = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT,
                                        timeout=timeout, check=False, cwd=temporary)
        except FileNotFoundError as error:
            raise ValueError(f"{worker} converter was not found; check its configured executable") from error
        except subprocess.TimeoutExpired as error:
            raise ValueError(f"{worker} import exceeded {timeout} seconds; simplify the file and try again") from error
        except OSError as error:
            raise ValueError(f"{worker} converter could not start; check its executable and permissions") from error
        report = None
        if report_path.is_file() and report_path.stat().st_size <= 64 * 1024:
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        if result.returncode != 0:
            message = report.get("error") if isinstance(report, dict) else None
            raise ValueError(message[:1600] if isinstance(message, str) and message else
                             f"{worker} could not read this file; export a self-contained GLB from its source application")
        if not isinstance(report, dict) or report.get("error") or not converted.is_file():
            raise ValueError(f"{worker} did not produce a complete product; reopen the source file, save it, and try again")
        if not 0 < converted.stat().st_size <= MAX_PRODUCT_BYTES:
            raise ValueError("Converted product exceeds the 128 MiB limit; reduce geometry or texture resolution")
        payload = converted.read_bytes()
        measured = inspect_product_glb(payload)
        report.update(dimensionsM=measured["dimensionsM"], vertexCount=measured["vertexCount"])
        if measured["vertexCount"] > 1000000:
            report.setdefault("warnings", []).append("This product contains over one million vertices. Its geometry is preserved; use a simplified source for faster editing.")
        if hashlib.sha256(source.read_bytes()).hexdigest() != source_digest:
            raise ValueError("The source file changed during import; save it and import again")
        report["sourceSha256"] = source_digest
        # Publish only after validation. A failed conversion never replaces a
        # previous good file, even when the caller reuses an output pathname.
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = None
        try:
            with tempfile.NamedTemporaryFile("wb", prefix=".product-import-", dir=destination.parent, delete=False) as handle:
                staging = Path(handle.name)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(staging, destination)
        finally:
            if staging is not None:
                staging.unlink(missing_ok=True)
        return report


def convert_cad_product(source_path, output_path, *, source_up="z", python=None, timeout=180):
    """Read document units; explicitly choose Y-up or Z-up for CAD display axes.

    Install the cad extra or set GESSO_CAD_PYTHON to a Python with cadquery-ocp.
    """
    if not isinstance(source_up, str) or source_up not in {"y", "z"}:
        raise ValueError("CAD source up axis must be y or z")
    executable = os.fspath(python or os.environ.get("GESSO_CAD_PYTHON") or sys.executable)
    return _convert(source_path, output_path, extensions=CAD_EXTENSIONS,
                    command=[executable, str(SCRIPTS / "import_cad_product.py")],
                    arguments=["--source-up", source_up], timeout=timeout, worker="CAD")


def convert_mesh_product(source_path, output_path, *, source_units, source_up, blender="blender", timeout=180):
    """Single-file geometry; OBJ companion MTL/textures require packed GLB/.blend."""
    if not isinstance(source_units, str) or source_units not in MESH_UNITS:
        raise ValueError("Choose source mesh units: mm, cm, m, in, or ft")
    if not isinstance(source_up, str) or source_up not in {"y", "z"}:
        raise ValueError("Mesh source up axis must be y or z")
    return _convert(source_path, output_path, extensions=MESH_EXTENSIONS,
                    command=[os.fspath(blender or "blender"), "--background", "--factory-startup", "--disable-autoexec",
                             "--python-exit-code", "1", "--python", str(SCRIPTS / "import_mesh_product.py"), "--"],
                    arguments=["--source-units", source_units, "--source-up", source_up],
                    timeout=timeout, worker="Mesh")
