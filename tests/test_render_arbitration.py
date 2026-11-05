"""Proofs take the next GPU boundary; a stream of proofs cannot starve film."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from film.render_arbitration import RenderArbiter


class ArbitrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name); self.gate = RenderArbiter(self.root)

    def test_proof_overtakes_waiting_export_and_marker_tracks_only_real_demand(self):
        order, workers = [], []
        with self.gate.slot() as lease:
            self.assertGreaterEqual(os.fstat(lease['gpuLockFd']).st_size, 0)
            self.assertFalse((self.root/'.proof-demand.json').exists())
            for foreground in (False, True):
                thread = threading.Thread(target=self.enter, args=(foreground,order)); thread.start(); workers.append(thread)
                self.wait_for(lambda: self.gate.foreground_waiters if foreground else self.gate.background_waiters)
            self.wait_for(lambda:(self.root/'.proof-demand.json').exists())
            marker = json.loads((self.root/'.proof-demand.json').read_text())
            self.assertEqual(marker['waiting'], 1)
        for thread in workers: thread.join(2); self.assertFalse(thread.is_alive())
        self.assertEqual(order, ['proof','film'])
        self.assertFalse((self.root/'.proof-demand.json').exists())

    def enter(self, foreground, order):
        with self.gate.slot(foreground): order.append('proof' if foreground else 'film')

    def wait_for(self, condition):
        deadline = time.monotonic()+1
        while time.monotonic()<deadline:
            if condition(): return
            time.sleep(.005)
        self.fail('Scheduling condition did not settle')

    def test_three_proof_limit_yields_to_background_and_releases_warm_resources(self):
        order=[]; self.gate.foreground_streak=3
        released=[]; self.gate.release_warm_worker=lambda:released.append(True)
        with self.gate.slot(True):
            film=threading.Thread(target=self.enter,args=(False,order)); film.start()
            self.wait_for(lambda:self.gate.background_waiters)
            proof=threading.Thread(target=self.enter,args=(True,order)); proof.start()
            self.wait_for(lambda:self.gate.foreground_waiters)
        for worker in (film,proof):worker.join(2);self.assertFalse(worker.is_alive())
        self.assertEqual(order,['film','proof']);self.assertEqual(released,[True])

    def test_cancelled_waiter_clears_marker_without_claiming_gpu(self):
        errors=[]
        def cancelled(): raise RuntimeError('cancelled fixture')
        def waiting():
            try:
                with self.gate.slot(True,cancel=cancelled): self.fail('Cancelled proof claimed GPU')
            except RuntimeError as error: errors.append(str(error))
        with self.gate.slot():
            worker=threading.Thread(target=waiting);worker.start();worker.join(2)
            self.assertEqual(errors,['cancelled fixture'])
            self.assertEqual(self.gate.foreground_waiters,0)
            self.assertFalse((self.root/'.proof-demand.json').exists())
