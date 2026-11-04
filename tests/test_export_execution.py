"""Execution labels follow actual receipts, including interrupted/legacy jobs."""
import json
from pathlib import Path
import tempfile
import unittest

from film.export_execution import execution_summary


class ExportExecutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'plate').mkdir()

    def test_no_gpu_claim_from_requested_auto_policy_or_missing_receipt(self):
        self.assertEqual(execution_summary(self.root), {})
        (self.root / 'render-config.json').write_text(json.dumps({'execution': {'policy': 'AUTO'}}))
        self.assertEqual(execution_summary(self.root), {})

    def test_actual_gpu_and_software_background_are_distinguished(self):
        (self.root / 'render-config.json').write_text(json.dumps({'execution': {
            'backend': 'METAL', 'devices': [{'name': 'Apple GPU', 'type': 'METAL', 'id': 'internal'}]}}))
        (self.root / 'plate' / 'capture-manifest.json').write_text(json.dumps({'profile': {'execution': {
            'backend': 'software', 'renderer': 'SwiftShader'}}}))
        self.assertEqual(execution_summary(self.root), {
            'cycles': {'backend': 'METAL', 'devices': [{'name': 'Apple GPU', 'type': 'METAL'}]},
            'gaussian': {'backend': 'software', 'renderer': 'SwiftShader'}})

    def test_cpu_fallback_is_visible_and_partial_writes_do_not_break_polling(self):
        (self.root / 'render-config.json').write_text(json.dumps({'execution': {
            'backend': 'CPU', 'fallbackReason': 'No compatible GPU', 'devices': []}}))
        (self.root / 'plate' / 'capture-manifest.json').write_text('{')
        self.assertEqual(execution_summary(self.root)['cycles']['fallbackReason'], 'No compatible GPU')
