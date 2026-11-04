#!/usr/bin/env python3
"""Retrieve two already-exported visual assets; never create provider work.

Only the allowlisted world GETs are permitted at the API transport boundary.
Provider metadata and download URLs stay in process memory. The artifact contains
the original GLBs and small, URL-free validation facts, never the API key.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film import worldlabs, worlds  # noqa: E402

REQUESTED_WORLDS = (
    ("3b652cca-99c2-4f3b-8f90-c26af9e2bc00", "water-courtyard-vertex-colored.glb"),
    ("4251f85f-b32d-435d-bff3-9966c1bf4749", "neutral-daylight-atrium-vertex-colored.glb"),
)
ALLOWED_API_PATHS = frozenset("/worlds/" + world_id for world_id, _ in REQUESTED_WORLDS)
OUTPUT_DIRECTORY = ROOT / "world-asset-comparison"


class RetrievalError(ValueError):
    """A safe, fixed diagnostic which contains no provider response material."""


class ReadOnlyWorldLabsClient(worldlabs.WorldLabsClient):
    def _request(self, method, path, payload=None):
        if method != "GET" or path not in ALLOWED_API_PATHS or payload is not None:
            raise RetrievalError("Only GET requests for the two existing comparison worlds are permitted.")
        return super()._request(method, path, payload)


def source_facts(payload):
    """Facts from validated source declarations, not a surface-quality score."""
    facts = worlds._validate_content(payload, "glb", "vertex-colored-world.glb")
    json_length = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + json_length].decode("utf-8"))
    accessors = document.get("accessors", [])
    triangles = primitives = colored = 0
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitives += 1
            attributes = primitive["attributes"]
            position = accessors[attributes["POSITION"]]
            count = position["count"]
            if "indices" in primitive:
                index = primitive["indices"]
                if type(index) is not int or not 0 <= index < len(accessors):
                    raise RetrievalError("The downloaded visual mesh has an invalid index accessor.")
                count = accessors[index]["count"]
            mode = primitive.get("mode", 4)
            if mode == 4:
                if count % 3:
                    raise RetrievalError("The downloaded visual mesh has an incomplete triangle list.")
                triangles += count // 3
            elif mode in (5, 6):
                triangles += max(0, count - 2)
            if "COLOR_0" in attributes:
                index = attributes["COLOR_0"]
                if (type(index) is not int or not 0 <= index < len(accessors)
                        or accessors[index]["count"] != position["count"]):
                    raise RetrievalError("The downloaded visual mesh has an invalid color accessor.")
                colored += 1
    if not colored or not triangles:
        raise RetrievalError("The requested vertex-colored visual mesh lacks source colors or triangles.")
    return {**facts, "primitiveCount": primitives, "triangleCount": triangles,
            "vertexColoredPrimitiveCount": colored,
            "basis": "Validated glTF accessor counts; unique mesh data, not a visual-quality approval"}


def retrieve_existing_assets(output, client):
    output = Path(output)
    if output.exists():
        raise RetrievalError("The comparison output already exists; preserve it and use a fresh run.")
    requested = []
    # Check both existing-world responses before downloading either asset.
    for ordinal, (world_id, filename) in enumerate(REQUESTED_WORLDS, 1):
        print(f"Phase: metadata {ordinal}/{len(REQUESTED_WORLDS)}", flush=True)
        world = client.get_world(world_id)
        if not isinstance(world, dict) or world.get("world_id") != world_id:
            raise RetrievalError("The provider did not return the requested existing world.")
        url = ((world.get("assets") or {}).get("mesh") or {}).get("full_res_mesh_url")
        if not url:
            raise RetrievalError("An already-exported vertex-colored mesh is unavailable; no export was requested.")
        worldlabs._validate_download_url(url)
        requested.append((world_id, filename, url))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".world-asset-readonly-", dir=output.parent) as temporary:
        staging = Path(temporary) / "artifact"
        staging.mkdir()
        records = []
        for ordinal, (world_id, filename, url) in enumerate(requested, 1):
            destination = staging / filename
            print(f"Phase: download {ordinal}/{len(REQUESTED_WORLDS)}", flush=True)
            downloaded = client._download(url, destination)
            print(f"Phase: validation {ordinal}/{len(REQUESTED_WORLDS)}", flush=True)
            payload = worlds._read_asset(destination)
            digest = hashlib.sha256(payload).hexdigest()
            if downloaded != {"sha256": digest, "bytes": len(payload)}:
                raise RetrievalError("The downloaded asset does not match its bounded transfer receipt.")
            facts = source_facts(payload)
            records.append({"worldId": world_id, "variant": "vertex_colored", "file": filename,
                            "sha256": digest, "bytes": len(payload), "facts": facts})
        manifest = {"schemaVersion": 1, "operation": "retrieve-existing-vertex-colored-meshes",
                    "providerApiMethods": ["GET"], "providerWorldReads": len(REQUESTED_WORLDS),
                    "providerWorkCreated": False, "additionalProviderCredits": 0,
                    "maxAssetBytes": worlds.MAX_ASSET_BYTES, "assets": records}
        print("Phase: publish verified artifact", flush=True)
        with (staging / "manifest.json").open("x", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        staging.rename(output)
    return manifest


def safe_failure_details(error):
    """Whitelist class/status/transport categories, never the raw exception."""
    name = type(error).__name__
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name):
        name = "Exception"
    details = ["exception=" + name]
    text = str(error)
    status = re.search(r"\bHTTP ([1-5][0-9]{2})\b", text)
    if status:
        details.append("http_status=" + status.group(1))
    known_labels = {
        "WORLDLABS_API_KEY is not configured on the server": "credential_not_configured",
        "World Labs API returned invalid JSON": "provider_invalid_json",
        "World Labs API connection failed; paid submissions are never automatically retried": "provider_connection_failed",
        "Provider asset download failed; no credentials were sent to the asset host": "asset_download_failed",
        "Provider world asset exceeds the import size limit": "asset_size_limit",
    }
    if text in known_labels:
        details.append("category=" + known_labels[text])
    return " ".join(details)


def main():
    try:
        print("Phase: initialize read-only client", flush=True)
        client = ReadOnlyWorldLabsClient.from_environment(timeout=90)
        result = retrieve_existing_assets(OUTPUT_DIRECTORY, client)
    except RetrievalError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        # Exceptions may contain response text, URLs or transport details.
        print("Read-only asset retrieval failed; no provider generation or export was requested. "
              + safe_failure_details(error), file=sys.stderr)
        return 1
    print(f"Verified {len(result['assets'])} existing vertex-colored meshes; no provider work was created.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
