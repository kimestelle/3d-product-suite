"""Transport for the Marble 2 beta Developer API and its signed asset URLs."""

from contextlib import closing
from email.utils import parsedate_to_datetime
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image


API_ROOT = "https://api.atlas-beta.worldlabs.ai/api/v2"
MAX_JSON_BYTES = 1024 * 1024
MAX_ASSET_BYTES = 32 * 1024 * 1024
MAX_IMAGE_PIXELS = 4 * 1024 * 1024
IMAGE_SUFFIXES = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}
IPV6_TRANSLATION = tuple(ipaddress.ip_network(prefix) for prefix in ("64:ff9b::/96", "64:ff9b:1::/48"))


class AtlasError(ValueError):
    def __init__(self, message, *, status=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def _identifier(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value) is None:
        raise AtlasError(f"Invalid Marble 2 {label}.")
    return value


def _retry_after(headers):
    value = headers.get("Retry-After", "") if headers else ""
    if re.fullmatch(r"[0-9]{1,9}", value):
        return int(value)
    try:
        return max(0, int(parsedate_to_datetime(value).timestamp() - time.time() + 0.999))
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _asset_target(url):
    if (not isinstance(url, str) or len(url) > 8192 or
            re.fullmatch(r"[!-~]+", url) is None or "\\" in url):
        raise AtlasError("Marble 2 returned an invalid asset URL.")
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError:
        raise AtlasError("Marble 2 returned an invalid asset URL.") from None
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or
            port not in (None, 443) or "#" in url or "%" in parsed.hostname):
        raise AtlasError("Marble 2 asset downloads require a public HTTPS URL.")
    host = parsed.hostname
    if "." not in host and ":" not in host:
        raise AtlasError("Marble 2 asset downloads require a public HTTPS URL.")
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    return host, path


def _public_addresses(host):
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(record[4][0] for record in records))
        for value in addresses:
            address = ipaddress.ip_address(value)
            translated = isinstance(address, ipaddress.IPv6Address) and (
                address.ipv4_mapped or address.sixtofour or address.teredo or
                any(address in prefix for prefix in IPV6_TRANSLATION)
            )
            if not address.is_global or address.is_multicast or address.is_reserved or translated:
                raise AtlasError("Marble 2 asset host resolved to a non-public address.")
    except OSError:
        raise AtlasError("Could not resolve the Marble 2 asset host.") from None
    if not addresses:
        raise AtlasError("Could not resolve the Marble 2 asset host.")
    return addresses


class _AssetConnection(http.client.HTTPSConnection):
    """Use vetted numeric addresses for TCP and the original hostname for TLS."""

    def __init__(self, host, addresses, timeout):
        super().__init__(host, timeout=timeout)
        self.addresses = addresses

    def connect(self):
        deadline = time.monotonic() + self.timeout
        for address in self.addresses:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                stream = socket.create_connection((address, self.port), min(5, remaining))
            except OSError:
                continue
            try:
                stream.settimeout(max(0.01, deadline - time.monotonic()))
                self.sock = self._context.wrap_socket(stream, server_hostname=self.host)
            except BaseException:
                stream.close()
                raise
            return
        raise OSError("Could not connect to a vetted asset address.")


def _depth_suffix(output):
    # Read only the EXR header. Bound both windows before serving the asset
    # to a decoder, and accept the simple single-part image formats only.
    header = output.read(64 * 1024)
    if len(header) < 9 or header[:4] != b"\x76\x2f\x31\x01":
        raise AtlasError("Marble 2 depth is missing its OpenEXR header.")
    version, = struct.unpack_from("<I", header, 4)
    if (version & 0xFF) not in (1, 2) or version & ~0x6FF:
        raise AtlasError("Marble 2 depth uses an unsupported OpenEXR format.")
    windows = set()
    cursor = 8
    while cursor < len(header) and header[cursor] != 0:
        name_end = header.find(b"\0", cursor, cursor + 256)
        if name_end < 0:
            break
        type_end = header.find(b"\0", name_end + 1, name_end + 257)
        if type_end < 0 or type_end + 5 > len(header):
            break
        name = header[cursor:name_end]
        length, = struct.unpack_from("<I", header, type_end + 1)
        start = type_end + 5
        cursor = start + length
        if cursor > len(header):
            break
        if name in (b"dataWindow", b"displayWindow"):
            if name in windows or header[name_end + 1:type_end] != b"box2i" or length != 16:
                raise AtlasError("Marble 2 depth has an invalid OpenEXR window.")
            x1, y1, x2, y2 = struct.unpack_from("<4i", header, start)
            width, height = x2 - x1 + 1, y2 - y1 + 1
            if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= MAX_IMAGE_PIXELS):
                raise AtlasError("Marble 2 depth exceeds the supported pixel budget.")
            windows.add(name)
    if cursor + 1 >= len(header) or header[cursor] != 0 or len(windows) != 2:
        raise AtlasError("Marble 2 depth has an invalid OpenEXR header.")
    return ".exr"


def _asset_suffix(output, kind):
    output.seek(0)
    if kind == "depth":
        return _depth_suffix(output)
    try:
        with Image.open(output, formats=tuple(IMAGE_SUFFIXES)) as image:
            width, height = image.size
            if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= MAX_IMAGE_PIXELS):
                raise AtlasError("Marble 2 image exceeds the supported pixel budget.")
            if getattr(image, "is_animated", False):
                raise AtlasError("Marble 2 returned an animated image in place of a frame.")
            image.load()
            return IMAGE_SUFFIXES[image.format]
    except AtlasError:
        raise
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise AtlasError("Marble 2 returned an invalid PNG, JPEG, or WebP image.") from None


class AtlasClient:
    def __init__(self, api_key, *, opener=None, timeout=30):
        if not isinstance(api_key, str) or re.fullmatch(r"[!-~]{1,4096}", api_key.strip()) is None:
            raise AtlasError("Configure a Marble 2 project key with WLT_API_KEY.")
        base = os.environ.get("WLT_API_BASE_URL", API_ROOT).rstrip("/")
        if base != API_ROOT:
            raise AtlasError("WLT_API_BASE_URL must point to the official Marble 2 beta API.")
        self._key = api_key.strip()
        self._opener = opener or urllib.request.build_opener(_NoRedirect())
        self.timeout = timeout

    def submit(self, body, idempotency_key):
        return self.submit_task("images2PosedRGBD", body, idempotency_key)

    def submit_task(self, task, body, idempotency_key):
        if task not in ("images2PosedRGBD", "atlasChisel", "posedImages2Splats"):
            raise AtlasError("Unsupported Marble 2 task.")
        key = _identifier(idempotency_key, "idempotency key")
        return self._request("POST", "/tasks:" + task, body, idempotency_key=key)

    def operation(self, operation_id):
        return self._request("GET", "/operations/" + _identifier(operation_id, "operation ID"))

    def _request(self, method, path, payload=None, *, idempotency_key=None):
        headers = {"WLT-Api-Key": self._key, "Accept": "application/json"}
        body = None
        if payload is not None:
            try:
                body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (ValueError, TypeError):
                raise AtlasError("Marble 2 request must contain valid JSON values.") from None
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(API_ROOT + path, data=body, method=method, headers=headers)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_JSON_BYTES + 1)
        except urllib.error.HTTPError as error:
            with closing(error):
                raise AtlasError(f"Marble 2 API returned HTTP {error.code}.", status=error.code,
                                 retry_after=_retry_after(error.headers)) from None
        except (OSError, http.client.HTTPException):
            raise AtlasError("Could not reach the Marble 2 beta API.") from None
        if len(raw) > MAX_JSON_BYTES:
            raise AtlasError("Marble 2 API response exceeds the size limit.")
        try:
            result = json.loads(raw)
        except (ValueError, RecursionError):
            raise AtlasError("Marble 2 API returned invalid JSON.") from None
        if not isinstance(result, dict):
            raise AtlasError("Marble 2 API returned an unexpected response.")
        return result

    def read_asset(self, asset_id, destination, *, kind, max_bytes=None):
        """Download a validated output into the caller's staging directory."""
        if kind not in ("image", "depth", "confidence", "splat"):
            raise AtlasError("Unsupported Marble 2 output kind.")
        max_bytes = MAX_ASSET_BYTES if max_bytes is None else max_bytes
        asset = _identifier(asset_id, "asset ID")
        grant = self._request("POST", f"/assets/{asset}:createReadUrl")
        host, path = _asset_target(grant.get("readUrl"))
        deadline = time.monotonic() + self.timeout
        addresses = _public_addresses(host)
        destination = Path(destination)
        temporary = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            with closing(_AssetConnection(host, addresses, remaining)) as connection:
                # The signed query is the only authorization for this request.
                connection.request("GET", path, headers={"Accept": "application/octet-stream"})
                stream = connection.sock
                with connection.getresponse() as response:
                    if response.status != 200:
                        raise AtlasError(f"Marble 2 asset download returned HTTP {response.status}.")
                    declared = response.getheader("Content-Length")
                    if declared is not None and (
                            re.fullmatch(r"[0-9]{1,9}", declared) is None or int(declared) > max_bytes):
                        raise AtlasError("Marble 2 asset exceeds the download size limit.")
                    with tempfile.NamedTemporaryFile(mode="w+b", prefix=".atlas-", dir=destination.parent,
                                                     delete=False) as output:
                        temporary = Path(output.name)
                        total = 0
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise TimeoutError
                            stream.settimeout(remaining)
                            chunk = response.read1(min(1024 * 1024, max_bytes - total + 1))
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > max_bytes:
                                raise AtlasError("Marble 2 asset exceeds the download size limit.")
                            output.write(chunk)
                        if not total or (declared is not None and total != int(declared)):
                            raise AtlasError("Marble 2 returned an empty or incomplete asset.")
                        if kind == "splat":
                            output.seek(0)
                            if output.read(2) != b"\x1f\x8b":
                                raise AtlasError("Marble 2 returned an unsupported SPZ container.")
                            suffix = ".spz"
                        else:
                            suffix = _asset_suffix(output, kind)
            os.replace(temporary, destination)
            return suffix
        except (OSError, http.client.HTTPException):
            raise AtlasError("Could not download the Marble 2 asset.") from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
