"""Restore the selected Leica GLB from its supplied packed source maps.

The source geometry/buffer remains intact. Height is a geometry-aware tangent
normal bake supplied by --maps (50 micrometre relief, source normal strength .5).
Original GLBs/scenes remain recoverable; output is a new content-addressed asset.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from film.store import ProjectStore


def restore(payload,maps):
    length=struct.unpack_from('<I',payload,12)[0]
    doc=json.loads(payload[20:20+length]);offset=20+length
    binary=bytearray(payload[offset+8:offset+8+struct.unpack_from('<I',payload,offset)[0]])
    def texture(name,roughness=False):
        im=Image.open(maps/name);im.thumbnail((2048,2048))
        if roughness:
            gray=im.convert('L');one=Image.new('L',im.size,255)
            im=Image.merge('RGB',(one,gray,one))
        out=io.BytesIO();im.save(out,format='PNG');data=out.getvalue()
        while len(binary)%4:binary.append(0)
        view=len(doc.setdefault('bufferViews',[]));doc['bufferViews'].append({'buffer':0,'byteOffset':len(binary),'byteLength':len(data)});binary.extend(data)
        image=len(doc.setdefault('images',[]));doc['images'].append({'bufferView':view,'mimeType':'image/png','name':name})
        tex=len(doc.setdefault('textures',[]));doc['textures'].append({'source':image});return tex
    metal=texture('Leica_Metal_normal.png');rough=texture('Leica_Metal_Roughness.png',True)
    leather=texture('Leica_Leather_Combined_Normal.png')
    for m in doc['materials']:
        p=m.setdefault('pbrMetallicRoughness',{})
        if m['name']=='Metal':
            m['normalTexture']={'index':metal,'scale':.3};p['metallicRoughnessTexture']={'index':rough};p['roughnessFactor']=1
        if m['name']=='Leather_Black':m['normalTexture']={'index':leather,'scale':1}
        if m['name'] in ('Lens','Glass','Glass_Exponometer'):
            p['metallicFactor']=0;p['roughnessFactor']=.025;p['baseColorFactor']=[.98,.99,1,1]
            m.setdefault('extensions',{}).update({'KHR_materials_transmission':{'transmissionFactor':1},'KHR_materials_ior':{'ior':1.5}})
    doc['extensionsUsed']=sorted(set(doc.get('extensionsUsed',[]))|{'KHR_materials_transmission','KHR_materials_ior'})
    for i in doc['scenes'][doc.get('scene',0)]['nodes']:doc['nodes'][i]['rotation']=[0,2**-.5,2**-.5,0]
    doc['buffers'][0]['byteLength']=len(binary)
    raw=json.dumps(doc,separators=(',',':')).encode();raw+=b' '*((-len(raw))%4);binary.extend(b'\0'*((-len(binary))%4))
    return struct.pack('<4sII',b'glTF',2,28+len(raw)+len(binary))+struct.pack('<I4s',len(raw),b'JSON')+raw+struct.pack('<I4s',len(binary),b'BIN\0')+binary


def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--project',required=True);p.add_argument('--maps',type=Path,required=True);p.add_argument('--source-revision');a=p.parse_args()
    store=ProjectStore(a.workspace);project=store.get(a.project);scene=store.get(a.project,a.source_revision)['scene'] if a.source_revision else project['scene'];component=scene['product']['components'][0]
    if scene['product'].get('revisionId','').startswith('leica-restored-'):raise ValueError('Leica restoration already applied; use the original revision to repeat.')
    payload=restore((a.workspace/component['asset']['path']).read_bytes(),a.maps);digest=hashlib.sha256(payload).hexdigest();path=Path('assets')/(digest+'.glb');(a.workspace/path).write_bytes(payload)
    component['asset'].update(path=path.as_posix(),sha256=digest)
    size=component['sizeM'];size[1],size[2]=size[2],size[1];scene['product']['dimensionsM']=list(size);component['assembly']['translationM'][1]=size[1]/2
    scene['product']['revisionId']='leica-restored-'+digest[:16]
    component.pop('sourceNodes',None)
    result=store.save(a.project,scene,project['headRevisionId']);print(json.dumps({'id':result['id'],'revisionId':result['revisionId'],'asset':path.as_posix()}))

if __name__=='__main__':main()
