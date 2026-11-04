#!/usr/bin/env python3
"""Check image liveness and hosted authentication on loopback only.

Run inside the freshly started application container. This uses its disposable
workspace; never send the access key or its cookie to a remote URL.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from film.hosting import COOKIE_NAME, HostedAccess


def loopback_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment or not parsed.port):
        raise ValueError('Image smoke test requires a loopback HTTP origin with an explicit port')
    return f'http://{parsed.netloc}'


def check_http(origin, *, timeout=90):
    origin = loopback_origin(origin)
    deadline = time.monotonic() + timeout
    while True:
        try:
            with urlopen(origin + '/api/health', timeout=3) as response:
                if response.status != 200 or json.load(response) != {'status': 'ok'}:
                    raise ValueError('Unexpected health response')
            break
        except (URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise ValueError('Container health did not become ready') from None
            time.sleep(1)
    try:
        with urlopen(origin + '/api/bootstrap', timeout=30):
            raise ValueError('Unauthenticated workspace request was accepted')
    except HTTPError as error:
        if error.code != 401 or 'no-store' not in error.headers.get('Cache-Control', ''):
            raise ValueError('Workspace authentication or private-cache boundary failed') from None
        error.close()
    key = os.environ.get('GESSO_ACCESS_KEY')
    if not key:
        key = Path(os.environ['GESSO_ACCESS_KEY_FILE']).read_text().rstrip('\n')
    access = HostedAccess(public_url=os.environ['GESSO_PUBLIC_URL'], access_key=key)
    request = Request(origin + '/api/bootstrap', headers={'Cookie': f'{COOKIE_NAME}={access.session()}'})
    with urlopen(request, timeout=30) as response:
        bootstrap = json.load(response)
        if response.status != 200 or 'scene' not in bootstrap.get('project', {}) or not bootstrap.get('capabilities'):
            raise ValueError('Authenticated bootstrap is incomplete')
    return {'status': 'ok', 'health': True, 'unauthenticatedWorkspaceDenied': True, 'authenticatedBootstrap': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8787')
    args = parser.parse_args()
    try:
        result = check_http(args.url)
    except Exception:
        # Do not echo paths, session cookies, environment values or response bodies.
        print(json.dumps({'status': 'failed', 'error': 'Container health/authentication check failed.'}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
