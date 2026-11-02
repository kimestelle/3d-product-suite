"""Extract the supplied Leica's packed maps without saving the source blend.
Run in Blender: --background --python scripts/extract_leica_maps.py -- --source FILE --output DIR
"""
import argparse
from pathlib import Path
import sys
import bpy

p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args(sys.argv[sys.argv.index('--')+1:]);a.output.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(Path(a.source).resolve()))
for image in bpy.data.images:
    if image.type=='IMAGE' and image.size[0] and image.name.startswith('Leica_'):
        image.filepath_raw=str(a.output.resolve()/(Path(image.name).stem+'.png'))
        image.file_format='PNG';image.save()
