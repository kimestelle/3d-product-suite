"""Deployment checks must prove execution and reject a mislabeled GPU host."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts.check_render_runtime import load_access_key_file, verify_runtime

ROOT = Path(__file__).resolve().parents[1]


class RenderRuntimeTests(unittest.TestCase):
    def proof(self, cycles='OPTIX', capture='hardware', require_gpu=True):
        def render(command, **kwargs):
            receipt=Path(command[-1])
            receipt.write_text(json.dumps({'engine':'CYCLES','rendered':True,'execution':{'backend':cycles}}))
            return subprocess.CompletedProcess(command,0,'','')
        with patch('scripts.check_render_runtime._check_tool',return_value={'version':'pinned'}), \
             patch('scripts.check_render_runtime.subprocess.run',side_effect=render), \
             patch('scripts.check_render_runtime.subprocess_json',return_value={'contextVerified':True,'execution':{'backend':capture}}):
            return verify_runtime(require_gpu=require_gpu)

    def test_gpu_admission_requires_both_actual_cycles_render_and_hardware_capture(self):
        self.assertEqual(self.proof()['status'],'ok')
        for cycles,capture in [('CPU','hardware'),('OPTIX','software'),('CPU','software')]:
            result=self.proof(cycles,capture)
            self.assertEqual(result['status'],'failed')
            self.assertTrue(result['errors'])

    def test_cpu_validation_does_not_claim_hardware(self):
        result=self.proof('CPU','software',require_gpu=False)
        self.assertEqual(result['status'],'ok')
        self.assertEqual(result['checks']['cycles']['execution']['backend'],'CPU')
        self.assertEqual(result['checks']['capture']['execution']['backend'],'software')

    def test_failed_render_does_not_become_a_successful_gpu_probe(self):
        with patch('scripts.check_render_runtime._check_tool',return_value={}), \
             patch('scripts.check_render_runtime.subprocess.run',side_effect=subprocess.CalledProcessError(1,[],stderr='missing OptiX kernel')), \
             patch('scripts.check_render_runtime.subprocess_json',return_value={'contextVerified':True,'execution':{'backend':'hardware'}}):
            result=verify_runtime(require_gpu=True)
        self.assertEqual(result['status'],'failed')
        self.assertNotIn('cycles',result['checks'])
        self.assertIn('missing OptiX kernel',' '.join(result['errors']))

    def test_docker_exec_loads_key_file_without_exposing_file_configuration_to_children(self):
        with tempfile.TemporaryDirectory() as directory:
            key=Path(directory)/'key';key.write_text('test-key-123456789012345678901234567890\n')
            with patch.dict(os.environ,{'GESSO_ACCESS_KEY_FILE':str(key)},clear=True):
                load_access_key_file()
                self.assertEqual(os.environ['GESSO_ACCESS_KEY'],'test-key-123456789012345678901234567890')
                self.assertNotIn('GESSO_ACCESS_KEY_FILE',os.environ)
            with patch.dict(os.environ,{'GESSO_ACCESS_KEY_FILE':str(key),'GESSO_ACCESS_KEY':'other'},clear=True):
                with self.assertRaisesRegex(ValueError,'not both'):load_access_key_file()

    def entrypoint(self, key_contents, *, environment=None):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            key=root/'key';key.write_text(key_contents)
            # Exercise the actual POSIX entrypoint as its unprivileged branch,
            # including when this unit suite itself runs as root in CI.
            ident=root/'id';ident.write_text('#!/bin/sh\necho 10001\n');ident.chmod(0o755)
            env={**os.environ,'PATH':str(root)+':'+os.environ['PATH'],'GESSO_ACCESS_KEY_FILE':str(key)}
            env.pop('GESSO_ACCESS_KEY',None)
            env.update(environment or {})
            return subprocess.run(['sh',str(ROOT/'scripts/container-entrypoint.sh'),sys.executable,'-c',
                "import os;assert len(os.environ['GESSO_ACCESS_KEY'])>=32;assert 'GESSO_ACCESS_KEY_FILE' not in os.environ"],
                env=env,text=True,capture_output=True)

    def test_entrypoint_reads_secret_without_printing_it(self):
        result=self.entrypoint('unit-test-secret-12345678901234567890\n')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,'')
        self.assertEqual(result.stderr,'')

    def test_entrypoint_rejects_short_or_conflicting_secrets(self):
        for secret,env in [('short',{}),('unit-test-secret-12345678901234567890',{'GESSO_ACCESS_KEY':'other'})]:
            with self.subTest(env=bool(env)):
                result=self.entrypoint(secret,environment=env)
                self.assertNotEqual(result.returncode,0)
                self.assertNotIn(secret,result.stdout+result.stderr)
