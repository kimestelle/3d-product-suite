"""Bounded fal image jobs. Queue receipts stay private and survive reloads."""

from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image

from .atlas_client import (AtlasError, _AssetConnection, _NoRedirect,
                           _asset_target, _identifier, _public_addresses, _retry_after)

MODEL = "fal-ai/nano-banana-pro/edit"
BASE_MODEL = "fal-ai/nano-banana-pro"
QUEUE_APP = "fal-ai/nano-banana-pro"
QUEUE_ROOT = "https://queue.fal.run/"
MAX_JSON_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
IMAGE_SUFFIXES = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}


def _image_suffix(output):
    output.seek(0)
    try:
        with Image.open(output, formats=tuple(IMAGE_SUFFIXES)) as image:
            width, height = image.size
            if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= 16 * 1024 * 1024):
                raise AtlasError("fal image exceeds the supported pixel budget.")
            if getattr(image, "is_animated", False):
                raise AtlasError("fal returned an animated image instead of a reference.")
            image.load()
            return IMAGE_SUFFIXES[image.format]
    except AtlasError:
        raise
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise AtlasError("fal returned an invalid reference image.") from None


class FalClient:
    def __init__(self, api_key, *, opener=None, timeout=30):
        if not isinstance(api_key, str) or re.fullmatch(r"[!-~]{1,4096}", api_key.strip()) is None:
            raise AtlasError("Configure a private fal key on the Gesso server.")
        self._key = api_key.strip()
        self._opener = opener or urllib.request.build_opener(_NoRedirect())
        self.timeout = timeout

    def _request(self, method, route, payload=None):
        headers = {"Authorization": "Key " + self._key, "Accept": "application/json"}
        body = None
        if payload is not None:
            body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
            headers["X-Fal-No-Retry"] = "1"
        request = urllib.request.Request(QUEUE_ROOT + route, data=body, method=method, headers=headers)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_JSON_BYTES + 1)
        except urllib.error.HTTPError as error:
            with closing(error):
                raise AtlasError(f"fal API returned HTTP {error.code}.", status=error.code,
                                 retry_after=_retry_after(error.headers)) from None
        except (OSError, http.client.HTTPException):
            raise AtlasError("Could not reach the fal image API.") from None
        if len(raw) > MAX_JSON_BYTES:
            raise AtlasError("fal returned an oversized response.")
        try:
            result = json.loads(raw)
        except (ValueError, RecursionError):
            raise AtlasError("fal returned invalid JSON.") from None
        if not isinstance(result, dict):
            raise AtlasError("fal returned an unexpected response.")
        return result

    def submit(self, body):
        body = dict(body)
        endpoint = MODEL if body.get("image_urls") else BASE_MODEL
        if endpoint == BASE_MODEL:
            body.pop("image_urls", None)
        result = self._request("POST", endpoint, body)
        return _identifier(result.get("request_id"), "fal request ID")

    def status(self, request_id):
        return self._request("GET", QUEUE_APP + "/requests/" + _identifier(request_id, "fal request ID") + "/status")

    def result(self, request_id):
        return self._request("GET", QUEUE_APP + "/requests/" + _identifier(request_id, "fal request ID"))

    def download_image(self, url, destination):
        """Use signed media authorization only, never the fal account key."""
        host, route = _asset_target(url)
        destination = Path(destination)
        temporary = None
        deadline = time.monotonic() + self.timeout
        addresses = _public_addresses(host)
        try:
            with closing(_AssetConnection(host, addresses, max(.01, deadline - time.monotonic()))) as connection:
                connection.request("GET", route, headers={"Accept": "image/png,image/jpeg,image/webp"})
                stream = connection.sock
                with connection.getresponse() as response:
                    if response.status != 200:
                        raise AtlasError(f"fal image download returned HTTP {response.status}.")
                    declared = response.getheader("Content-Length")
                    if declared is not None and (not re.fullmatch(r"[0-9]{1,9}", declared) or int(declared) > MAX_IMAGE_BYTES):
                        raise AtlasError("fal image exceeds the download limit.")
                    with tempfile.NamedTemporaryFile(mode="w+b", prefix=".fal-", dir=destination.parent, delete=False) as output:
                        temporary = Path(output.name)
                        total = 0
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise TimeoutError
                            stream.settimeout(remaining)
                            chunk = response.read1(min(1024 * 1024, MAX_IMAGE_BYTES - total + 1))
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > MAX_IMAGE_BYTES:
                                raise AtlasError("fal image exceeds the download limit.")
                            output.write(chunk)
                        if not total or declared is not None and total != int(declared):
                            raise AtlasError("fal returned an empty or incomplete image.")
                        suffix = _image_suffix(output)
            os.replace(temporary, destination)
            return suffix
        except (OSError, http.client.HTTPException):
            raise AtlasError("Could not download the fal reference image.") from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
