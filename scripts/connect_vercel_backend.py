#!/usr/bin/env python3
"""Connect the Vercel editor to a persistent backend, or restore the static demo.

This changes repository configuration only. It does not deploy a service, contact
Vercel, read credentials, or copy a backend access key into the frontend.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film.hosting import https_origin  # noqa: E402


API_SOURCE = "/api/:path*"
API_HEADERS_SOURCE = "/api/(.*)"
PRIVATE_HEADERS = [
    {"key": "Cache-Control", "value": "private, no-store"},
    {"key": "Vercel-CDN-Cache-Control", "value": "no-store"},
]


def _managed_rewrite(item):
    if not isinstance(item, dict) or item.get("source") != API_SOURCE:
        return False
    destination = item.get("destination", "")
    if not isinstance(destination, str) or not destination.endswith("/api/:path*"):
        return False
    try:
        https_origin(destination.removesuffix("/api/:path*"))
    except ValueError:
        return False
    return set(item) == {"source", "destination"}


def backend_config(config, backend_url=None, *, demo=False):
    """Preserve unrelated routing and headers while changing the owned API route."""
    if demo == bool(backend_url):
        raise ValueError("Choose a backend HTTPS origin or --demo")
    origin = https_origin(backend_url) if backend_url else None
    if not isinstance(config, dict):
        raise ValueError("Vercel configuration must be a JSON object")
    result = deepcopy(config)
    for name in ("rewrites", "headers"):
        if name in result and not isinstance(result[name], list):
            raise ValueError(f"Vercel {name} must be an array")
    rewrites = [item for item in result.get("rewrites", []) if not _managed_rewrite(item)]
    if not demo and any(isinstance(item, dict) and item.get("source") == API_SOURCE for item in rewrites):
        raise ValueError("A custom /api/:path* rewrite already exists; review it before connecting the backend")

    headers = []
    for item in result.get("headers", []):
        if isinstance(item, dict) and item.get("source") == API_HEADERS_SOURCE:
            remaining = [header for header in item.get("headers", []) if header not in PRIVATE_HEADERS]
            if remaining:
                headers.append({**item, "headers": remaining})
        else:
            headers.append(item)
    result["buildCommand"] = f"npm run {'build:demo' if demo else 'build'} --prefix web"
    if origin:
        # Put the specific API proxy before existing generic SPA rewrites.
        rewrites.insert(0, {"source": API_SOURCE, "destination": f"{origin}/api/:path*"})
        headers.append({"source": API_HEADERS_SOURCE, "headers": deepcopy(PRIVATE_HEADERS)})
    for name, items in (("rewrites", rewrites), ("headers", headers)):
        if items:
            result[name] = items
        else:
            result.pop(name, None)
    return result


def configure(path, backend_url=None, *, demo=False):
    path = Path(path)
    config = backend_config(json.loads(path.read_text(encoding="utf-8")), backend_url, demo=demo)
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend_url", nargs="?", help="Exact HTTPS origin of the deployed backend")
    parser.add_argument("--demo", action="store_true", help="Restore the browser-only demo build")
    parser.add_argument("--config", type=Path, default=ROOT / "vercel.json")
    args = parser.parse_args(argv)
    try:
        configure(args.config, args.backend_url, demo=args.demo)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"Updated {args.config}. Review and deploy this configuration to Vercel.")


if __name__ == "__main__":
    main()
