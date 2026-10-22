"""The hosted editor configuration stays reversible and never embeds credentials."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.connect_vercel_backend import backend_config, configure


ROOT = Path(__file__).resolve().parents[1]
STATIC_CONFIG = {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "vite",
    "installCommand": "npm ci --prefix web --ignore-scripts",
    "buildCommand": "npm run build:demo --prefix web",
    "outputDirectory": "web/dist",
}


class HostingConfigTests(unittest.TestCase):
    def test_connects_full_editor_and_routes_all_api_paths_without_a_function(self):
        original = {**STATIC_CONFIG, "rewrites": [{"source": "/legacy", "destination": "/"}]}
        configured = backend_config(original, "https://GESSO-API.onrender.com/")
        self.assertEqual(configured["buildCommand"], "npm run build --prefix web")
        self.assertEqual(configured["rewrites"], [
            {"source": "/api/:path*", "destination": "https://gesso-api.onrender.com/api/:path*"},
            {"source": "/legacy", "destination": "/"},
        ])
        self.assertEqual(configured["headers"], [{"source": "/api/(.*)", "headers": [
            {"key": "Cache-Control", "value": "private, no-store"},
            {"key": "Vercel-CDN-Cache-Control", "value": "no-store"},
        ]}])
        self.assertEqual(original["buildCommand"], STATIC_CONFIG["buildCommand"])
        for key in ("$schema", "framework", "installCommand", "outputDirectory"):
            self.assertEqual(configured[key], original[key])

    def test_repeat_connection_is_idempotent_and_backend_can_be_replaced(self):
        first = backend_config(STATIC_CONFIG, "https://first.onrender.com")
        self.assertEqual(backend_config(first, "https://first.onrender.com"), first)
        next_config = backend_config(first, "https://second.onrender.com")
        self.assertNotIn("first.onrender.com", json.dumps(next_config))
        self.assertEqual(len(next_config["rewrites"]), 1)
        self.assertEqual(len(next_config["headers"]), 1)

    def test_restoring_demo_preserves_unrelated_routes_and_headers(self):
        original = {**STATIC_CONFIG, "rewrites": [{"source": "/old", "destination": "/about"}], "headers": [
            {"source": "/assets/(.*)", "headers": [{"key": "X-Example", "value": "asset"}]},
            {"source": "/api/(.*)", "headers": [{"key": "X-Example", "value": "api"}]},
        ]}
        configured = backend_config(original, "https://gesso.onrender.com")
        restored = backend_config(configured, demo=True)
        self.assertEqual(restored, original)
        self.assertEqual(backend_config(backend_config(STATIC_CONFIG, "https://gesso.onrender.com"), demo=True), STATIC_CONFIG)

    def test_invalid_origins_and_ambiguous_modes_leave_file_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "vercel.json"
            contents = json.dumps(STATIC_CONFIG)
            config.write_text(contents)
            for origin in ("http://backend.example", "https://example.com/api", "https://user:key@example.com",
                           "https://example.com/?key=secret", "https://*.example.com", "https://example.com/#key", "https://example.com:70000"):
                with self.subTest(origin=origin), self.assertRaises(ValueError):
                    configure(config, origin)
                self.assertEqual(config.read_text(), contents)
            with self.assertRaises(ValueError):
                configure(config, "https://example.com", demo=True)
            with self.assertRaises(ValueError):
                configure(config)
            self.assertEqual(config.read_text(), contents)

    def test_custom_api_rewrite_cannot_be_silently_overwritten(self):
        config = {**STATIC_CONFIG, "rewrites": [{"source": "/api/:path*", "destination": "/other/:path*"}]}
        with self.assertRaisesRegex(ValueError, "custom"):
            backend_config(config, "https://example.com")
        self.assertEqual(backend_config(config, demo=True), config)

    def test_cli_runs_from_another_directory_and_restores_demo(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "vercel.json"
            config.write_text(json.dumps(STATIC_CONFIG))
            command = [sys.executable, str(ROOT / "scripts" / "connect_vercel_backend.py"), "--config", str(config)]
            subprocess.run([*command, "https://gesso.onrender.com"], cwd=directory, check=True, capture_output=True)
            self.assertEqual(json.loads(config.read_text())["buildCommand"], "npm run build --prefix web")
            subprocess.run([*command, "--demo"], cwd=directory, check=True, capture_output=True)
            self.assertEqual(json.loads(config.read_text()), STATIC_CONFIG)


if __name__ == "__main__":
    unittest.main()
