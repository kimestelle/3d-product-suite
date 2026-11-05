"""Spark handoff accepts only the current token and complete canonical plates."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from film import jobs
from film.capture_schedule import _validated_yield, run_scheduled_capture
from film.proof_inputs import digest
from tests.test_jobs import png_bytes


class CaptureScheduleTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.root=Path(directory.name);self.output=self.root/'renders'/'job';self.output.mkdir(parents=True)
        self.plate=self.output/'plate';self.plate.mkdir()
        self.payload={'scene':{'fixture':'canonical'},'frames':[{'frame':i} for i in (1,2,3)]}
        (self.output/'samples.json').write_text(json.dumps(self.payload))
        self.source=digest(self.payload['scene']);self.samples=digest(self.payload)
        (self.output/'job.json').write_text(json.dumps({'schemaVersion':1,'sceneDigest':self.source,'renderProfile':{'width':4,'height':6}}))
        self.manifest={'sourceDigest':self.source,'samplesDigest':self.samples,'profile':{'frameNumbers':[1,2,3],'worldCopy':{'status':'full-source'}},'frames':{}}
        self.token='b'*32
        self.receipt={'schemaVersion':1,'token':self.token,'sourceDigest':self.source,'samplesDigest':self.samples,'completed':[],'retainedFullSource':True}

    def write(self):
        (self.plate/'capture-manifest.json').write_text(json.dumps(self.manifest))
        (self.output/'capture-yield.json').write_text(json.dumps(self.receipt))

    def add(self,frame):
        path=self.plate/f'{frame:06d}.png';path.write_bytes(png_bytes())
        actual=jobs._sha256(path);self.manifest['frames'][str(frame)]=actual
        self.receipt['completed'].append({'frame':frame,'sha256':actual})

    def test_accepts_complete_plate_hashes_and_empty_candidate_fallback_only(self):
        self.write();self.assertEqual(_validated_yield(self.output,self.token,[1,2,3]),[])
        self.add(1);self.write();self.assertEqual(_validated_yield(self.output,self.token,[1,2,3]),[1])
        self.receipt['token']='a'*32;self.write()
        with self.assertRaisesRegex(RuntimeError,'pinned source'): _validated_yield(self.output,self.token,[1,2,3])
        self.receipt['token']=self.token;self.write();(self.plate/'000001.png').write_bytes(png_bytes(value=80))
        with self.assertRaisesRegex(RuntimeError,'pinned source'): _validated_yield(self.output,self.token,[1,2,3])

    def test_resume_releases_slot_and_reuses_same_command_after_partial_progress(self):
        calls=[]
        def process(command,output,log_name,**kwargs):
            calls.append(kwargs)
            if len(calls)==1:
                self.add(1);self.receipt['token']=kwargs['environment']['GESSO_CAPTURE_BATCH_TOKEN'];self.write()
        command=['node','capture.mjs','--frames','1,2,3']
        with patch.object(jobs,'_run_process_unlocked',side_effect=process):
            run_scheduled_capture(command,self.output,'capture.log',worker_fd=123)
        self.assertEqual(len(calls),2)
        self.assertNotEqual(calls[0]['environment']['GESSO_CAPTURE_BATCH_TOKEN'],calls[1]['environment']['GESSO_CAPTURE_BATCH_TOKEN'])
        self.assertEqual(calls[0]['worker_fd'],123)
        self.assertEqual(len(calls[0]['extra_fds']),1)
        self.assertFalse((self.root/'.proof-demand.json').exists())

    def test_repeated_empty_yields_fail_instead_of_spinning(self):
        def process(command,output,log_name,**kwargs):
            self.receipt['token']=kwargs['environment']['GESSO_CAPTURE_BATCH_TOKEN'];self.write()
        with patch.object(jobs,'_run_process_unlocked',side_effect=process), self.assertRaisesRegex(RuntimeError,'without making progress'):
            run_scheduled_capture(['node','capture.mjs','--frames','1,2,3'],self.output,'capture.log')
