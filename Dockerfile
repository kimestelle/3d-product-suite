# syntax=docker/dockerfile:1
# Linux/amd64 is the deployment target. Keep renderer versions aligned with film/jobs.py.
FROM node:24.19.0-bookworm-slim AS editor
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
# proxy_ca is optional and only needed by development environments with a TLS proxy.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --prefix web --ignore-scripts
COPY web ./web
COPY examples ./examples
RUN npm run build --prefix web

FROM python:3.12.14-slim-trixie AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/chromium \
    HOME=/home/gesso \
    PORT=8787 \
    GESSO_DATA_DIR=/data/workspace
WORKDIR /app
COPY --from=editor /usr/local/bin/node /usr/local/bin/node
COPY --from=editor /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=editor /app/web ./web
COPY pyproject.toml ./
COPY film ./film
COPY scripts ./scripts
COPY examples ./examples
# Keep the large tool installation in one layer. Debian 13 provides the exact
# renderers in the scene contract; a missing pinned package must fail the build.
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      export PIP_CERT=/run/secrets/proxy_ca NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git gh gosu \
       blender=4.3.2+dfsg-2 ffmpeg=7:7.1.5-0+deb13u1 \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && python -m pip install -e '.[cad]' \
    && cd /app/web && npx playwright install --with-deps chromium \
    && cd /app \
    && python -c "from film.jobs import _check_tool, BLENDER_VERSION, FFMPEG_VERSION; _check_tool('blender', 'blender', BLENDER_VERSION); _check_tool('ffmpeg', 'ffmpeg', FFMPEG_VERSION)" \
    && useradd --create-home --uid 10001 gesso \
    && chown -R gesso:gesso /home/gesso \
    && mkdir -p /data \
    && chown gesso:gesso /data \
    && chmod -R a+rX /app /opt/chromium \
    && chmod +x scripts/container-entrypoint.sh \
    && rm -rf /var/lib/apt/lists/* /tmp/pip-*
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8787') + '/api/health', timeout=4).read()"
# The entrypoint fixes the mounted volume's top-level ownership, then drops root.
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
CMD []
