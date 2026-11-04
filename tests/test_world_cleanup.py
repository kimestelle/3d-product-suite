"""Surface cleanup uses existing faces and preserves a recoverable source."""
import copy
import hashlib
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from film.world_cleanup import WorldCleanup, _Glb, _encode
from film import worlds


def grid_glb(*, warp=.01, rotation=None, scale=None, size=6, z_size=None, profile=None):
    positions, uvs, normals, indices = [], [], [], []
    z_size = z_size or size
    def point(x, z):
        height = profile(x/size, z/z_size) if profile else warp if 0 < x < size and 0 < z < z_size else 0.
        return (x/size, height, z/z_size)
    # Deliberately duplicate vertices per face like the supplied Water export.
    for z in range(z_size):
        for x in range(size):
            for corners in (((x,z),(x,z+1),(x+1,z)), ((x+1,z),(x,z+1),(x+1,z+1))):
                for px, pz in corners:
                    indices.append(len(positions));positions.append(point(px,pz));uvs.append((px/size,pz/z_size));normals.append((0.,1.,0.))
    document = {'asset':{'version':'2.0'},'buffers':[{'byteLength':0}], 'bufferViews':[], 'accessors':[],
                'materials':[{'name':'shared atlas', 'extensions':{'KHR_materials_unlit':{}}}],
                'nodes':[{'mesh':0,'name':'original',**({'rotation':rotation} if rotation else {}),**({'scale':scale} if scale else {})}],
                'meshes':[{'primitives':[{'attributes':{},'material':0}]}], 'scene':0, 'scenes':[{'nodes':[0]}]}
    binary = bytearray()
    for name, data, count, kind, fmt in (
        ('POSITION',positions,len(positions),'VEC3','<fff'),
        ('NORMAL',normals,len(normals),'VEC3','<fff'),
        ('TEXCOORD_0',uvs,len(uvs),'VEC2','<ff'),
        ('indices',[(i,) for i in indices],len(indices),'SCALAR','<I')):
        encoded = b''.join(struct.pack(fmt,*values) for values in data)
        document['bufferViews'].append({'buffer':0,'byteOffset':len(binary),'byteLength':len(encoded)})
        document['accessors'].append({'bufferView':len(document['bufferViews'])-1,'componentType':5125 if name=='indices' else 5126,'count':count,'type':kind})
        binary.extend(encoded)
        primitive=document['meshes'][0]['primitives'][0]
        if name=='indices':primitive['indices']=len(document['accessors'])-1
        else:primitive['attributes'][name]=len(document['accessors'])-1
    return _encode(document,binary)


class WorldCleanupTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);(self.root/'assets').mkdir()
        self.engine=WorldCleanup(self.root)
        self.payload=grid_glb()
        self.environment=self.add(self.payload)

    def add(self,payload):
        digest=hashlib.sha256(payload).hexdigest();(self.root/'assets'/f'{digest}.glb').write_bytes(payload)
        return {'revisionId':'source','kind':'mesh','asset':{'sha256':digest,'path':f'assets/{digest}.glb','format':'glb',
          'sourceUp':'Y','scaleToMeters':1.,'translationM':[0,0,0],'rotationXyzw':[0,0,0,1]},
          'worldColor':[.1,.1,.1], 'provenance':{'source':'Original synthetic test','owner':'test','reuseBasis':'Original','allowedExternalDestinations':[]},
          'plinth':{'id':'p','sizeM':[1,.1,1],'translationM':[0,0,0],'visible':False}}

    def analysis(self,environment=None):
        return self.engine.analyze(environment or self.environment,{'minFaces':4,'distanceThresholdSourceUnits':.2})

    def request(self,analysis,operation='separate',budget=.02):
        return {'analysisId':analysis['id'],'regionId':analysis['candidates'][0]['id'],'role':'floor','operation':operation,
                'maxDisplacementSourceUnits':budget}

    def test_analysis_is_deterministic_source_bound_and_never_claims_semantics(self):
        first=self.analysis();second=self.analysis()
        self.assertEqual(first,second)
        self.assertEqual(first['triangleCount'],72)
        self.assertEqual(first['method'],'geometric-only')
        candidate=first['candidates'][0]
        self.assertEqual(candidate['orientation'],'horizontal')
        self.assertIsNone(candidate['suggestedRole'])
        self.assertEqual(candidate['faceCount'],72)
        self.assertNotIn('groups',candidate)
        selection=self.engine.selection(first['id'],candidate['id'])
        self.assertEqual(selection['sourceSha256'],self.environment['asset']['sha256'])
        self.assertEqual(selection['groups'][0]['faceIndices'],list(range(72)))
        self.assertEqual((self.root/self.environment['asset']['path']).read_bytes(),self.payload)

    def test_separate_keeps_original_vertex_attribute_bytes_and_all_triangles(self):
        result=self.engine.preview(self.environment,self.request(self.analysis()))
        derived=_Glb((self.root/result['environment']['asset']['path']).read_bytes())
        original=_Glb(self.payload)
        self.assertTrue(derived.binary.startswith(original.binary))
        self.assertEqual(derived.document['materials'],original.document['materials'])
        self.assertEqual(derived.document['meshes'][-1]['primitives'][0]['attributes'],original.document['meshes'][0]['primitives'][0]['attributes'])
        self.assertEqual(result['report']['movedVertices'],0)
        self.assertFalse(result['report']['geometryChanged'])
        self.assertEqual(result['report']['sourceTriangles'],result['report']['outputTriangles'])
        self.assertEqual(len(derived.instances),1)
        worlds._validate_content((self.root/result['environment']['asset']['path']).read_bytes(),'glb','cleanup.glb')

    def test_flatten_only_moves_interior_preserves_boundary_and_original_uv_values(self):
        analysis=self.analysis()
        result=self.engine.preview(self.environment,self.request(analysis,'flatten'))
        report=result['report']
        self.assertGreater(report['movedVertices'],0)
        self.assertEqual(report['boundaryVerticesPreserved'],24)
        self.assertLessEqual(report['maxDisplacementSourceUnits'],.02)
        self.assertLess(report['finalRmsDeviationSourceUnits'],report['initialRmsDeviationSourceUnits'])
        self.assertLessEqual(report['maxEdgeLengthChangeRatio'], report['edgeLengthChangeRatioLimit'])
        self.assertLessEqual(report['maxNormalRotationDegrees'], report['normalRotationDegreesLimit'])
        source=_Glb(self.payload);derived=_Glb((self.root/result['environment']['asset']['path']).read_bytes())
        old=source.instances[0]['primitive'];new=derived.instances[-1]['primitive']
        _,s,step,_=source.attribute(old['attributes']['POSITION'])
        _,d,dstep,_=derived.attribute(new['attributes']['POSITION'])
        _,su,sustep,_=source.attribute(old['attributes']['TEXCOORD_0'])
        _,du,dustep,_=derived.attribute(new['attributes']['TEXCOORD_0'])
        count=derived.document['accessors'][new['attributes']['POSITION']]['count']
        for index in range(count):
            before=source.binary[s+index*step:s+index*step+12]
            after=derived.binary[d+index*dstep:d+index*dstep+12]
            x,y,z=struct.unpack('<fff',before)
            if x in (0.,1.) or z in (0.,1.):self.assertEqual(before,after)
            self.assertEqual(source.binary[su+index*sustep:su+index*sustep+8],derived.binary[du+index*dustep:du+index*dustep+8])
        self.assertEqual((self.root/self.environment['asset']['path']).read_bytes(),self.payload)

    def test_over_budget_repair_refuses_without_writing_a_derived_asset(self):
        request=self.request(self.analysis(),'flatten',.000001)
        before=set((self.root/'assets').iterdir())
        with self.assertRaisesRegex(ValueError,'limit'):
            self.engine.preview(self.environment,request)
        self.assertEqual(before,set((self.root/'assets').iterdir()))

    def test_shallow_dense_grid_cannot_create_a_steep_boundary_band(self):
        environment = self.add(grid_glb(size=8, z_size=256, profile=lambda x,z: .01*math.sin(math.pi*x)))
        analysis = self.engine.analyze(environment)
        self.assertEqual(analysis['candidates'][0]['faceCount'], 4096)
        before=set((self.root/'assets').iterdir())
        with self.assertRaisesRegex(ValueError, 'distort the retained boundary'):
            self.engine.preview(environment, self.request(analysis, 'flatten', .01))
        self.assertEqual(before, set((self.root/'assets').iterdir()))

    def test_shared_edges_and_unselected_faces_stay_exact(self):
        analysis=self.engine.analyze(self.environment, {'minFaces':4, 'distanceThresholdSourceUnits':.04})
        chosen=self.engine.selection(analysis['id'], analysis['candidates'][0]['id'])['groups'][0]['faceIndices']
        self.assertEqual(len(chosen), 34)
        result=self.engine.preview(self.environment, self.request(analysis, 'flatten'))
        source=_Glb(self.payload);geometry=source.geometry(source.instances[0])
        outside={identity for face in range(geometry.faces) if face not in chosen for identity in geometry.face_vertices(face)}
        derived=_Glb((self.root/result['environment']['asset']['path']).read_bytes())
        remaining, selected=derived.instances
        self.assertEqual(remaining['primitive']['attributes'], source.instances[0]['primitive']['attributes'])
        selected_ids=[geometry.indices[face*3+corner] for face in chosen for corner in range(3)]
        ordered=list(dict.fromkeys(selected_ids))
        _,start,stride,_=source.attribute(source.instances[0]['primitive']['attributes']['POSITION'])
        _,output,step,_=derived.attribute(selected['primitive']['attributes']['POSITION'])
        preserved=0
        for index, original in enumerate(ordered):
            if geometry.original_to_weld[original] in outside:
                self.assertEqual(source.binary[start+original*stride:start+original*stride+12],
                                 derived.binary[output+index*step:output+index*step+12])
                preserved+=1
        self.assertGreater(preserved, 0)
        self.assertEqual(len(derived.triangles(remaining)[0])//3, 38)
        self.assertEqual(result['report']['outputTriangles'], 72)

    def test_projection_cannot_collapse_or_invert_triangles(self):
        environment=self.add(grid_glb(warp=0, scale=[.3,1,1]))
        analysis=self.analysis(environment)
        evidence=self.engine._load(analysis['id'])
        # Isolate the topology guard from candidate detection and evidence
        # verification: a vertical projection would collapse this flat grid.
        evidence['candidates'][0]['plane']={'normal':[1.,0.,0.], 'offset':-.15}
        before=set((self.root/'assets').iterdir())
        with patch.object(self.engine, '_load', return_value=evidence):
            with self.assertRaisesRegex(ValueError, 'collapse or invert'):
                self.engine.preview(environment, self.request(analysis, 'flatten', .2))
        self.assertEqual(before, set((self.root/'assets').iterdir()))

    def test_node_rotation_is_part_of_detection_and_is_preserved(self):
        rotation=[math.sqrt(.5),0,0,math.sqrt(.5)]
        environment=self.add(grid_glb(warp=0,rotation=rotation))
        analysis=self.analysis(environment)
        self.assertEqual(analysis['candidates'][0]['orientation'],'vertical')
        result=self.engine.preview(environment,self.request(analysis))
        d=_Glb((self.root/result['environment']['asset']['path']).read_bytes()).document
        self.assertEqual(d['nodes'][0]['rotation'],rotation)

    def test_role_confirmation_and_analysis_identity_are_required(self):
        analysis=self.analysis();request=self.request(analysis)
        request['role']=None
        with self.assertRaisesRegex(ValueError,'Confirm'):
            self.engine.preview(self.environment,request)
        another=self.add(grid_glb(warp=.015))
        with self.assertRaisesRegex(ValueError,'different world'):
            self.engine.preview(another,self.request(analysis))

    def test_modified_analysis_or_source_is_rejected(self):
        analysis=self.analysis()
        path=self.root/'world-cleanup'/f"{analysis['id']}.json"
        value=json.loads(path.read_text());value['candidates'][0]['groups'][0]['faceIndices']=[0]
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'evidence changed'):
            self.engine.selection(analysis['id'],analysis['candidates'][0]['id'])
        (self.root/self.environment['asset']['path']).write_bytes(self.payload+b'bad')
        with self.assertRaisesRegex(ValueError,'source asset changed'):
            self.analysis()

    def test_unsupported_animated_world_is_explicit(self):
        d=_Glb(self.payload);document=copy.deepcopy(d.document);document['animations']=[{}]
        environment=self.add(_encode(document,bytearray(d.binary)))
        with self.assertRaisesRegex(ValueError,'Animated'):
            self.analysis(environment)


if __name__=='__main__':unittest.main()
