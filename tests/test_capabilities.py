"""Advertise local rendering only when the pinned worker can use the binaries."""
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from film import server


class RenderCapabilitiesTests(unittest.TestCase):
    def application(self):
        # No data seeding or queue thread is needed for version capability checks.
        with patch.object(server, 'ProjectStore'), patch.object(server, 'GitHubWorlds', return_value=SimpleNamespace(url='https://example.test/workflow')), \
             patch.object(server, 'RenderQueue', return_value=SimpleNamespace(blender='/local/blender', ffmpeg='/local/ffmpeg')), patch.object(server, 'ComparisonJobs'):
            return server.Application('/unused')

    def test_missing_tools_are_disabled_with_required_versions(self):
        app = self.application()
        with patch.object(server.shutil, 'which', return_value=None), patch.object(server.jobs, '_check_tool') as check:
            capabilities = app.capabilities()
        check.assert_not_called()
        self.assertFalse(capabilities['blenderAvailable'])
        self.assertFalse(capabilities['ffmpegAvailable'])
        self.assertEqual(capabilities['blenderIssue'], 'Blender 4.3.2 required; not found.')
        self.assertEqual(capabilities['ffmpegIssue'], 'FFmpeg 7.1.5 required; not found.')
        self.assertIn('worldlabsConfigured', capabilities)
        self.assertEqual(capabilities['githubWorkflowUrl'], 'https://example.test/workflow')

    def test_wrong_versions_are_disabled_despite_executable_presence(self):
        app = self.application()
        def version(command, **kwargs):
            return SimpleNamespace(stdout='Blender 5.1.1\nBuild details' if command[0] == '/local/blender' else 'ffmpeg version 8.0 Copyright\nBuild details')
        with patch.object(server.shutil, 'which', side_effect=lambda command: command), patch.object(server.jobs.subprocess, 'run', side_effect=version) as run:
            capabilities = app.capabilities()
        self.assertFalse(capabilities['blenderAvailable']); self.assertFalse(capabilities['ffmpegAvailable'])
        self.assertEqual(capabilities['blenderIssue'], 'Blender 4.3.2 required; found Blender 5.1.1.')
        self.assertIn('FFmpeg 7.1.5 required; found ffmpeg version 8.0', capabilities['ffmpegIssue'])
        self.assertEqual(run.call_args_list[0].args[0], ['/local/blender', '--version'])
        self.assertEqual(run.call_args_list[1].args[0], ['/local/ffmpeg', '-version'])

    def test_supported_versions_are_available_and_cached_per_application(self):
        app = self.application()
        def version(command, **kwargs):
            return SimpleNamespace(stdout='Blender 4.3.2\nBuild details' if command[0] == '/local/blender' else 'ffmpeg version 7.1.5 Copyright')
        with patch.object(server.shutil, 'which', side_effect=lambda command: command), patch.object(server.jobs.subprocess, 'run', side_effect=version) as run:
            first = app.capabilities(); second = app.capabilities()
            self.assertEqual(run.call_count, 2)
            first['blenderAvailable'] = False
            self.assertTrue(app.capabilities()['blenderAvailable'])
            self.assertEqual(run.call_count, 2)
        self.assertTrue(second['blenderAvailable']); self.assertTrue(second['ffmpegAvailable'])
        self.assertIsNone(second['blenderIssue']); self.assertIsNone(second['ffmpegIssue'])

    def test_unrunnable_installed_tool_reports_a_short_required_version_issue(self):
        app = self.application()
        with patch.object(server.shutil, 'which', side_effect=lambda command: command), patch.object(server.jobs.subprocess, 'run', side_effect=subprocess.TimeoutExpired('blender', 30)):
            result = app.capabilities()
        self.assertFalse(result['blenderAvailable'])
        self.assertEqual(result['blenderIssue'], 'Blender 4.3.2 required; the installed command could not run.')
        self.assertNotIn('TimeoutExpired', result['blenderIssue'])

if __name__ == '__main__': unittest.main()
