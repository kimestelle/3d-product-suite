"""Opt-in access to one shared, persistent hosted workspace."""

import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
import os
import re
import secrets
import time
from urllib.parse import urlsplit

COOKIE_NAME = "gesso_session"
SESSION_SECONDS = 12 * 60 * 60


class LoginRequired(Exception):
    pass


def https_origin(value):
    """Accept exact public origins, never paths, credentials or wildcards."""
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not re.fullmatch(r"[a-zA-Z0-9.-]+(?::[0-9]+)?", parsed.netloc)):
        raise ValueError("Hosted URLs must be exact HTTPS origins without paths or credentials")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid hosted URL port")
    return "https://" + parsed.netloc.lower()


def return_path(value):
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or any(ord(char) < 32 or char == "\\" for char in value)
            or value.startswith("/api/")):
        return "/"
    return value


class HostedAccess:
    def __init__(self, *, public_url=None, backend_url=None, access_key=None):
        self.public_url = https_origin(public_url) if public_url else None
        self.backend_url = https_origin(backend_url) if backend_url else None
        self.key = access_key or ""
        if self.public_url and len(self.key) < 32:
            raise ValueError("Hosted mode requires GESSO_ACCESS_KEY with at least 32 characters")
        if not self.public_url and (self.key or self.backend_url):
            raise ValueError("Set GESSO_PUBLIC_URL to enable hosted mode")

    @classmethod
    def from_environment(cls):
        return cls(public_url=os.environ.get("GESSO_PUBLIC_URL"),
                   backend_url=os.environ.get("GESSO_BACKEND_URL") or os.environ.get("RENDER_EXTERNAL_URL"),
                   access_key=os.environ.get("GESSO_ACCESS_KEY"))

    @property
    def enabled(self):
        return self.public_url is not None

    @property
    def origins(self):
        return {origin for origin in (self.public_url, self.backend_url) if origin}

    @property
    def hosts(self):
        return {urlsplit(origin).netloc for origin in self.origins}

    def matches_key(self, value):
        return hmac.compare_digest(value.encode("utf-8"), self.key.encode("utf-8"))

    def session(self):
        message = f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_hex(16)}"
        signature = hmac.new(self.key.encode("utf-8"), message.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{message}.{signature}"

    def authorized(self, cookie_header):
        if not self.enabled:
            return True
        try:
            cookies = SimpleCookie()
            cookies.load(cookie_header or "")
            value = cookies[COOKIE_NAME].value
            if not re.fullmatch(r"[0-9]{1,12}\.[a-f0-9]{32}\.[a-f0-9]{64}", value):
                return False
            expiry, nonce, signature = value.split(".")
            if not time.time() < int(expiry) <= time.time() + SESSION_SECONDS + 60:
                return False
            expected = hmac.new(self.key.encode("utf-8"), f"{expiry}.{nonce}".encode("ascii"), hashlib.sha256).hexdigest()
            return hmac.compare_digest(signature, expected)
        except (CookieError, KeyError, ValueError):
            return False

    def cookie(self):
        return f"{COOKIE_NAME}={self.session()}; Path=/api; Max-Age={SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict"
