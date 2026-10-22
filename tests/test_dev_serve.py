"""Launcher checks use fake executables, never installed tools or Keychain."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / "scripts" / "dev-serve.sh"


class DevServeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gesso-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        self.script = self.root / "scripts" / "dev-serve.sh"
        shutil.copyfile(LAUNCHER, self.script)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.root), "GESSO_KEYCHAIN": "0"}
        self.fake_python(self.bin / "python3.12", True)
        self.tool(self.bin / "blender", "Blender 4.3.2")
        self.tool(self.bin / "ffmpeg", "ffmpeg version 7.1.5 Copyright")
        self.tool(self.bin / "uname", "Darwin")
        self.executable(self.bin / "security", f'#!/bin/sh\ntouch "{self.root / "keychain-called"}"\n')

    def executable(self, path, source):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        path.chmod(0o755)
        return path

    def tool(self, path, output):
        return self.executable(path, f"#!/bin/sh\nprintf '%s\\n' '{output}'\n")

    def fake_python(self, path, compatible):
        return self.executable(path, f'''#!{sys.executable}
import json, os, pathlib, sys
if sys.argv[1:2] == ['-c']:
    raise SystemExit({0 if compatible else 1})
if sys.argv[1:3] == ['-m', 'certifi']:
    raise SystemExit(1)
pathlib.Path({str(self.root / 'call.json')!r}).write_text(json.dumps({{
    'python': sys.argv[0], 'argv': sys.argv[1:],
    'device': os.environ.get('GESSO_CYCLES_DEVICE'),
    'denoise': os.environ.get('GESSO_CYCLES_DENOISE'),
    'certificate': os.environ.get('SSL_CERT_FILE'),
    'root': os.environ.get('GESSO_ROOT'),
}}))
''')

    def launch(self, *args, **environment):
        return subprocess.run(["/bin/bash", str(self.script), *args], env={**self.env, **environment},
                              capture_output=True, text=True, timeout=10)

    def call(self):
        return json.loads((self.root / "call.json").read_text())

    def test_skips_incompatible_venv_and_keeps_launcher_acceleration_defaults(self):
        self.fake_python(self.root / ".venv" / "bin" / "python", False)
        result = self.launch("--port", "8890")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.call()
        self.assertEqual(call["python"], str(self.bin / "python3.12"))
        self.assertEqual(call["argv"][-2:], ["--port", "8890"])
        self.assertEqual((call["device"], call["denoise"]), ("METAL", "1"))
        self.assertEqual(call["root"], str(self.root))
        self.assertFalse((self.root / "keychain-called").exists())

    def test_explicit_paths_with_spaces_and_environment_values_are_preserved(self):
        python = self.fake_python(self.root / "chosen python" / "python", True)
        blender = self.tool(self.root / "chosen blender" / "blender", "Blender 4.3.2")
        ffmpeg = self.tool(self.root / "chosen ffmpeg" / "ffmpeg", "ffmpeg version 7.1.5 Copyright")
        result = self.launch(GESSO_PYTHON=str(python), BLENDER=str(blender), FFMPEG=str(ffmpeg),
                             GESSO_CYCLES_DEVICE="CPU", GESSO_CYCLES_DENOISE="0", SSL_CERT_FILE="/custom/cert.pem")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.call()
        self.assertEqual(call["python"], str(python))
        self.assertEqual(call["argv"][-4:], ["--blender", str(blender), "--ffmpeg", str(ffmpeg)])
        self.assertEqual((call["device"], call["denoise"]), ("CPU", "0"))
        self.assertEqual(call["certificate"], "/custom/cert.pem")

    def test_rejects_an_explicit_wrong_python_instead_of_ignoring_the_override(self):
        python = self.fake_python(self.root / "wrong-python", False)
        result = self.launch(GESSO_PYTHON=str(python))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires Python 3.12", result.stderr)
        self.assertFalse((self.root / "call.json").exists())

    def test_help_does_not_access_keychain(self):
        result = self.launch("--help", GESSO_KEYCHAIN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.call()["argv"], ["-m", "film", "serve", "--help"])
        self.assertFalse((self.root / "keychain-called").exists())

    def test_existing_credential_is_not_replaced_with_keychain(self):
        result = self.launch(GESSO_KEYCHAIN="1", WORLDLABS_API_KEY="test-placeholder")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "keychain-called").exists())

    def test_missing_explicit_renderer_is_reported_before_starting_server(self):
        result = self.launch(BLENDER=str(self.root / "not-installed"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("override is not executable", result.stderr)
        self.assertFalse((self.root / "call.json").exists())


if __name__ == "__main__":
    unittest.main()
