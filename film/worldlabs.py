"""Server-side World Labs access with durable, explicitly budgeted submissions.

This module never reads keys from a project, returns them to a browser, or retries
an uncertain paid POST. All provider traffic is isolated behind a small transport
so tests do not require credentials or make paid requests.
"""
from __future__ import annotations

from contextlib import contextmanager
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from film import worlds

API_ROOT = "https://api.worldlabs.ai/marble/v1"
DOCUMENTATION_CHECKED_AT = "2026-10-16"
TEXT_GENERATION_MAX_CREDITS = {"marble-1.0-draft": 230, "marble-1.0": 1580,
                               "marble-1.1": 1580, "marble-1.1-plus": 3080}
HQ_MESH_EXPORT_CREDITS = 3500
# A supported 6 MiB inline image can be echoed as 8 MiB of base64 in a World.
MAX_API_RESPONSE_BYTES = 12 * 1024 * 1024


def estimate_pair(model="marble-1.1"):
    """Conservative documented text generation plus one HQ export, not a quote."""
    _require(model in TEXT_GENERATION_MAX_CREDITS, "Unsupported World Labs model")
    generation = TEXT_GENERATION_MAX_CREDITS[model]
    return {"model": model, "generationMaxCredits": generation,
            "meshExportMaxCredits": HQ_MESH_EXPORT_CREDITS,
            "totalMaxCredits": generation + HQ_MESH_EXPORT_CREDITS,
            "totalMaxUsd": (generation + HQ_MESH_EXPORT_CREDITS) / 1250,
            "documentationCheckedAt": DOCUMENTATION_CHECKED_AT}


class WorldLabsError(ValueError):
    """A provider failure safe to expose without leaking credentials."""


def _require(condition, message):
    if not condition:
        raise WorldLabsError(message)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".worldlabs-",
                                         delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            json.dump(document, handle, sort_keys=True, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _identifier(value, label):
    _require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value), f"Invalid {label}")
    return value


@contextmanager
def _state_lock(directory):
    """Do not let concurrent local commands submit the same paid request."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".worldlabs.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WorldLabsError("World Labs state is busy in another local command") from error
        yield
    finally:
        os.close(descriptor)


def load_generation(directory):
    """Read local provider state; callers should expose only selected fields."""
    path = Path(directory) / "generation.json"
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorldLabsError("Cannot read World Labs generation state") from error
    _require(isinstance(result, dict) and result.get("schemaVersion") == 1,
             "Invalid World Labs generation state")
    return result


def _validate_download_url(url):
    _require(isinstance(url, str) and len(url) <= 8192, "Provider asset URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    _require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password,
             "Provider asset URL must use HTTPS without credentials")
    try:
        port = parsed.port
    except ValueError as error:
        raise WorldLabsError("Provider asset URL port is invalid") from error
    _require(port in (None, 443), "Provider asset URL port must be 443")
    host = parsed.hostname.lower().rstrip(".")
    _require(host not in ("localhost", "metadata.google.internal") and not host.endswith((".localhost", ".local", ".internal")),
             "Provider asset URL must identify a public host")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        _require("." in host, "Provider asset URL must identify a public host")
    else:
        _require(address.is_global, "Provider asset URL must identify a public host")
    _require(not parsed.fragment, "Provider asset URL must not contain a fragment")
    return url


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        _validate_download_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise WorldLabsError("World Labs API unexpectedly redirected; credentials were not forwarded")


class WorldLabsClient:
    """Standard-library client; the API key stays in server process memory."""

    def __init__(self, api_key, *, timeout=30, opener=None, download_opener=None):
        _require(isinstance(api_key, str) and api_key.strip() and "\r" not in api_key and "\n" not in api_key,
                 "WORLDLABS_API_KEY is not configured on the server")
        _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 300,
                 "World Labs timeout must be between 0 and 300 seconds")
        self._api_key = api_key.strip()
        self.timeout = timeout
        self._opener = opener or urllib.request.build_opener(_NoRedirect())
        self._download_opener = download_opener or urllib.request.build_opener(_SafeRedirect())

    @classmethod
    def from_environment(cls, **kwargs):
        return cls(os.environ.get("WORLDLABS_API_KEY", ""), **kwargs)

    def __repr__(self):
        return "WorldLabsClient(api_key=<redacted>)"

    def get_credits(self):
        return self._request("GET", "/credits")

    def get_world(self, world_id):
        return self._request("GET", "/worlds/" + _identifier(world_id, "provider world ID"))

    def get_operation(self, operation_id):
        return self._request("GET", "/operations/" + _identifier(operation_id, "operation ID"))

    def _check_balance(self, required_credits):
        credits = self.get_credits().get("remaining_credits")
        _require(type(credits) in (int, float) and math.isfinite(credits) and credits >= 0,
                 "World Labs returned an invalid API credit balance")
        _require(credits >= required_credits,
                 "World Labs API balance does not cover this operation's documented maximum charge")

    def create_generation(self, directory, *, name, text_prompt, max_credits, model="marble-1.1", seed=42,
                          image_url=None, image_path=None):
        """Create one private text/image world with an explicit maximum budget."""
        _require(isinstance(name, str) and 0 < len(name.strip()) <= 64,
                 "World Labs display name must be 1 to 64 characters")
        _require(isinstance(text_prompt, str) and 0 < len(text_prompt.strip()) <= 20000,
                 "World Labs text prompt must be 1 to 20000 characters")
        _require(type(seed) is int and 0 <= seed <= 4294967295, "World Labs seed must be a uint32 integer")
        _require(not (image_url and image_path), "Supply an image URL or local image path, not both")
        image = None
        if image_url:
            _validate_download_url(image_url)
            image = {"source": "uri", "uri": image_url}
        if image_path:
            path = Path(image_path)
            try:
                _require(path.is_file() and 0 < path.stat().st_size <= 6 * 1024 * 1024,
                         "Inline reference image must be a nonempty file of at most 6 MiB")
                payload = path.read_bytes()
            except OSError:
                raise WorldLabsError("Cannot read the local reference image") from None
            _require(len(payload) <= 6 * 1024 * 1024, "Inline reference image exceeds 6 MiB")
            if payload.startswith(b"\x89PNG\r\n\x1a\n"):
                extension = "png"
            elif payload.startswith(b"\xff\xd8\xff"):
                extension = "jpg"
            elif len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
                extension = "webp"
            else:
                raise WorldLabsError("Reference image must have a PNG, JPEG or WebP file signature")
            image = {"source": "data_base64", "data_base64": base64.b64encode(payload).decode("ascii"), "extension": extension}
        expected = estimate_pair(model)["generationMaxCredits"]
        self._validate_budget(max_credits, expected)
        _require(not (Path(directory) / "generation.json").exists(),
                 "World Labs generation already exists; resume it or attach an existing operation")
        self._check_balance(expected)
        request = {"display_name": name.strip(), "model": model, "seed": seed,
                   "permission": {"public": False, "allow_id_access": False,
                                  "allowed_readers": [], "allowed_writers": []},
                   "world_prompt": {"type": "text", "text_prompt": text_prompt.strip()}}
        if image is not None:
            request["world_prompt"].update(type="image", image_prompt=image, is_pano=False)
        return self._submit(directory, request=request, max_credits=max_credits, expected_credits=expected)

    def _redact(self, value):
        """Do not persist inline private image contents or an echoed API key."""
        if isinstance(value, dict):
            return {key: ({"omitted": True, "encodedSha256": hashlib.sha256(str(child).encode()).hexdigest()}
                          if key == "data_base64" else self._redact(child)) for key, child in value.items()}
        if isinstance(value, list):
            return [self._redact(child) for child in value]
        return value.replace(self._api_key, "<redacted>") if isinstance(value, str) else value

    def create_mesh_export(self, directory, world_id, *, max_credits, mesh_variant="textured"):
        """Request an HQ visual GLB; an existing/running export is provider-cached."""
        world_id = _identifier(world_id, "provider world ID")
        _require(mesh_variant in ("textured", "vertex_colored"), "Mesh variant must be textured or vertex_colored")
        self._validate_budget(max_credits, HQ_MESH_EXPORT_CREDITS)
        _require(not (Path(directory) / "generation.json").exists(),
                 "World Labs generation already exists; resume it or attach an existing operation")
        self._check_balance(HQ_MESH_EXPORT_CREDITS)
        return self._submit(directory, request={"asset_type": "mesh", "format": "glb", "mesh_variant": mesh_variant},
                            max_credits=max_credits, expected_credits=HQ_MESH_EXPORT_CREDITS,
                            api_path="/worlds/" + world_id + ":export", operation_type="mesh-export", world_id=world_id)

    @staticmethod
    def _validate_budget(max_credits, expected_credits):
        for label, value in (("Maximum credits", max_credits), ("Expected credits", expected_credits)):
            _require(type(value) in (int, float) and math.isfinite(value) and value > 0,
                     label + " must be a finite positive number")
        _require(expected_credits <= max_credits, "Expected World Labs charge exceeds the authorized credit cap")

    def _submit(self, directory, *, request, max_credits, expected_credits, api_path="/worlds:generate",
                operation_type="generation", world_id=None):
        """Persist intent before POST; every ambiguous outcome blocks resubmission."""
        self._validate_budget(max_credits, expected_credits)
        directory = Path(directory)
        with _state_lock(directory):
            path = directory / "generation.json"
            _require(not path.exists(), "World Labs generation already exists; resume it or attach an existing operation")
            state = {"schemaVersion": 1, "provider": "worldlabs", "state": "submitting", "createdAt": _now(),
                     "updatedAt": _now(), "maxCredits": max_credits, "expectedCredits": expected_credits,
                     "request": self._redact(request), "requestPath": api_path, "operationType": operation_type,
                     "documentationCheckedAt": DOCUMENTATION_CHECKED_AT}
            if world_id is not None:
                state["worldId"] = world_id
            _atomic_json(path, state)
            try:
                operation = self._request("POST", api_path, request)
                operation_id = _identifier(operation.get("operation_id"), "operation ID in provider response")
                state.update(state="pending", operationId=operation_id, operation=self._redact(operation), updatedAt=_now())
                _atomic_json(path, state)
            except (WorldLabsError, OSError) as error:
                # Even a malformed successful response can represent a paid accepted
                # request. Do not retry when the operation identity is not durable.
                state.update(state="submission_uncertain", updatedAt=_now(),
                             error="Submission outcome is uncertain. Find the accepted operation in World Labs before attaching it; do not create another generation.")
                _atomic_json(path, state)
                raise WorldLabsError(state["error"]) from None
            return state

    def poll_generation(self, directory):
        """Poll an existing generation/export once. Polling never creates work."""
        with _state_lock(directory):
            state = load_generation(directory)
            _require(state.get("operationId"), "No operation ID is saved; attach the accepted provider operation before polling")
            operation = self.get_operation(state["operationId"])
            _require(operation.get("operation_id") == state["operationId"], "Provider returned a different operation ID")
            _require(type(operation.get("done")) is bool, "Provider operation has no valid done flag")
            state.update(operation=self._redact(operation), updatedAt=_now())
            if not operation["done"]:
                state["state"] = "pending"
            elif operation.get("error") is not None:
                state.update(state="failed", error="World Labs operation failed; inspect its operation ID in the provider platform")
            else:
                response = operation.get("response")
                _require(isinstance(response, dict), "Completed World Labs operation has no result")
                if state.get("operationType", "generation") == "generation":
                    state["worldId"] = _identifier(response.get("world_id"), "provider world ID in generation result")
                    state["world"] = self._redact(response)
                else:
                    _require(response.get("asset_type") == "mesh" and response.get("format") == "glb",
                             "Mesh export did not return a visual GLB")
                    _validate_download_url(response.get("url"))
                    state["export"] = self._redact(response)
                state["state"] = "completed"
                state.pop("error", None)
                cost = operation.get("cost")
                if isinstance(cost, dict) and type(cost.get("total_credits")) is int:
                    state["settledCredits"] = cost["total_credits"]
                    if cost["total_credits"] > state["maxCredits"]:
                        state["budgetExceeded"] = True
            _atomic_json(Path(directory) / "generation.json", state)
            return state

    def import_world_pair(self, world_id, library_root, *, name, owner, reuse_basis,
                          resolution="500k", mesh_variant="textured", mesh_scale_to_meters=1,
                          mesh_ground_plane_offset=0):
        """Import existing HQ GLB and SPZ from one provider world, without POST."""
        world_id = _identifier(world_id, "provider world ID")
        _require(resolution in ("full_res", "500k", "150k", "100k"), "Unsupported World Labs SPZ resolution")
        _require(mesh_variant in ("textured", "vertex_colored"), "Mesh variant must be textured or vertex_colored")
        _require(isinstance(name, str) and 0 < len(name.strip()) <= 140, "World pair name must be 1 to 140 characters")
        _require(type(mesh_scale_to_meters) in (int, float) and math.isfinite(mesh_scale_to_meters)
                 and mesh_scale_to_meters > 0, "Reviewed mesh scale must be finite and positive")
        _require(type(mesh_ground_plane_offset) in (int, float) and math.isfinite(mesh_ground_plane_offset),
                 "Reviewed mesh ground offset must be finite")
        world = self.get_world(world_id)
        _require(world.get("world_id") == world_id, "Provider returned a different world ID")
        assets = world.get("assets") or {}
        _require(isinstance(assets, dict), "World Labs world assets are unavailable")
        meshes, splats = assets.get("mesh") or {}, assets.get("splats") or {}
        _require(isinstance(meshes, dict) and isinstance(splats, dict), "World Labs asset metadata is invalid")
        mesh_field = "hq_mesh_url" if mesh_variant == "textured" else "full_res_mesh_url"
        mesh_url = meshes.get(mesh_field)
        _require(mesh_url, "World has no requested HQ visual mesh. Request an explicitly budgeted mesh export; a collider cannot substitute.")
        spz_urls = splats.get("spz_urls") or {}
        _require(isinstance(spz_urls, dict) and spz_urls.get(resolution), "World has no SPZ at the requested resolution")
        splat_url = spz_urls[resolution]
        _validate_download_url(mesh_url)
        _validate_download_url(splat_url)
        semantics = splats.get("semantics_metadata") or {}
        _require(isinstance(semantics, dict), "World Labs semantic scale metadata is invalid")
        scale, ground = semantics.get("metric_scale_factor"), semantics.get("ground_plane_offset")
        _require(type(scale) in (int, float) and math.isfinite(scale) and scale > 0,
                 "World lacks a valid metric scale; review and import legacy exports manually")
        _require(type(ground) in (int, float) and math.isfinite(ground),
                 "World lacks a valid ground-plane offset; review and import legacy exports manually")
        provenance = {"source": "World Labs generated world " + world_id, "owner": owner, "reuseBasis": reuse_basis,
                      "allowedExternalDestinations": [], "provider": "worldlabs", "providerWorldId": world_id,
                      "providerModel": world.get("model"), "providerSemantics": {"metric_scale_factor": scale,
                                                                                 "ground_plane_offset": ground},
                      "axisConvention": "marble_raw_opencv", "documentationCheckedAt": DOCUMENTATION_CHECKED_AT,
                      "alignmentReview": "Unreviewed initial alignment. SPZ uses provider metric metadata; HQ GLB units and ground require independent review. Verify product scale and orientation before comparison.",
                      "metricScaleInferred": scale != 1.0}
        worlds.validate_provenance(provenance)
        with tempfile.TemporaryDirectory(prefix="worldlabs-import-") as temporary:
            paths = {"mesh": Path(temporary) / "visual-world.glb", "splat": Path(temporary) / "gaussian-world.spz"}
            self._download(mesh_url, paths["mesh"])
            self._download(splat_url, paths["splat"])
            # Validate both before writing either library entry.
            worlds._validate_content(worlds._read_asset(paths["mesh"]), "glb", paths["mesh"].name)
            worlds._validate_content(worlds._read_asset(paths["splat"]), "spz", paths["splat"].name)
            entries = {}
            for kind, path in paths.items():
                specific = dict(provenance, representation="hq-visual-glb" if kind == "mesh" else "gaussian-spz")
                specific["meshVariant" if kind == "mesh" else "splatResolution"] = mesh_variant if kind == "mesh" else resolution
                specific["alignmentBasis"] = ("Caller-supplied mesh metric scale and ground offset; defaults 1 and 0 are uncalibrated"
                                                if kind == "mesh" else "World Labs SPZ metric semantics, ground offset, then OpenCV-to-OpenGL rotation")
                representation_scale = mesh_scale_to_meters if kind == "mesh" else scale
                representation_ground = mesh_ground_plane_offset if kind == "mesh" else ground
                entries[kind] = worlds.import_world(path, library_root,
                    name=name.strip() + (" · Visual mesh" if kind == "mesh" else " · Gaussian splat"),
                    provenance=specific, source_up="Y", scale_to_meters=representation_scale,
                    rotation_xyzw=[1, 0, 0, 0], translation_m=[0, representation_ground, 0])
        return {"provider": "worldlabs", "worldId": world_id, "reviewStatus": "unreviewed", **entries}

    def attach_operation(self, directory, operation_id, *, operation_type=None, world_id=None, max_credits=None):
        """Explicit recovery by existing operation ID; this never submits work."""
        operation_id = _identifier(operation_id, "operation ID")
        with _state_lock(directory):
            if (Path(directory) / "generation.json").exists():
                state = load_generation(directory)
            else:
                _require(operation_type in ("generation", "mesh-export"), "Recovery needs an explicit operation type")
                self._validate_budget(max_credits, max_credits)
                _require(operation_type != "mesh-export" or world_id, "Mesh export recovery needs its world ID")
                state = {"schemaVersion": 1, "provider": "worldlabs", "createdAt": _now(),
                         "operationType": operation_type, "maxCredits": max_credits, "recoveredExistingOperation": True}
                if world_id is not None:
                    state["worldId"] = _identifier(world_id, "provider world ID")
            _require(not state.get("operationId") or state["operationId"] == operation_id,
                     "Generation already tracks a different operation")
            if operation_type is not None:
                _require(state.get("operationType", "generation") == operation_type,
                         "Recovery operation type differs from the saved operation")
            if world_id is not None:
                _require(state.get("worldId", world_id) == world_id,
                         "Recovery world ID differs from the saved mesh operation")
            operation = self.get_operation(operation_id)
            returned_id = operation.get("operation_id", operation_id)
            _require(returned_id == operation_id, "Provider returned a different operation ID")
            state.update(operationId=operation_id, operation=self._redact(operation), state="pending", updatedAt=_now())
            state.pop("error", None)
            _atomic_json(Path(directory) / "generation.json", state)
            return state

    def _request(self, method, path, payload=None):
        _require(path.startswith("/") and not path.startswith("//"), "Invalid World Labs API path")
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode() if payload is not None else None
        request = urllib.request.Request(API_ROOT + path, data=body, method=method,
                                         headers={"WLT-Api-Key": self._api_key, "Accept": "application/json",
                                                  "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_API_RESPONSE_BYTES + 1)
            _require(len(raw) <= MAX_API_RESPONSE_BYTES, "World Labs API response is too large")
            result = json.loads(raw)
            _require(isinstance(result, dict), "World Labs API response must be an object")
            return result
        except urllib.error.HTTPError as error:
            # Error bodies can contain request material; do not log or expose them.
            raise WorldLabsError(f"World Labs API returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise WorldLabsError("World Labs API connection failed; paid submissions are never automatically retried") from None
        except (UnicodeError, json.JSONDecodeError) as error:
            raise WorldLabsError("World Labs API returned invalid JSON") from None

    def _download(self, url, destination):
        url = _validate_download_url(url)
        destination = Path(destination)
        # The CDN request deliberately has no provider authentication header.
        request = urllib.request.Request(url, headers={"Accept": "application/octet-stream"})
        total = 0
        digest = hashlib.sha256()
        try:
            with self._download_opener.open(request, timeout=self.timeout) as response, destination.open("wb") as output:
                _validate_download_url(response.geturl())
                declared = response.headers.get("Content-Length")
                if declared is not None:
                    _require(declared.isdecimal() and int(declared) <= worlds.MAX_ASSET_BYTES,
                             "Provider world asset exceeds the import size limit")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    _require(total <= worlds.MAX_ASSET_BYTES, "Provider world asset exceeds the import size limit")
                    output.write(chunk)
                    digest.update(chunk)
            _require(total > 0, "Provider world asset is empty")
        except WorldLabsError:
            destination.unlink(missing_ok=True)
            raise
        except (OSError, urllib.error.URLError, TimeoutError):
            destination.unlink(missing_ok=True)
            raise WorldLabsError("Provider asset download failed; no credentials were sent to the asset host") from None
        return {"sha256": digest.hexdigest(), "bytes": total}
