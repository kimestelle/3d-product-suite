"""Bake source leather normal + shallow height relief on original UVs; run with Blender."""
import bpy,os,bmesh,argparse,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("--glb",required=True);p.add_argument("--maps",type=Path,required=True);a=p.parse_args(sys.argv[sys.argv.index("--")+1:])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.glb))
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=1;scene.render.bake.use_clear=False
objects=[o for o in scene.objects if o.type=='MESH' and any(m and m.name=='Leather_Black' for m in o.data.materials)]
m=bpy.data.materials['Leather_Black'];m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links
p=next(x for x in n if x.type=='BSDF_PRINCIPLED')
normal=n.new('ShaderNodeTexImage');normal.image=bpy.data.images.load(str(a.maps/'Leica_Leather_Normal.png'));normal.image.colorspace_settings.name='Non-Color'
nm=n.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.5;l.new(normal.outputs['Color'],nm.inputs['Color'])
height=n.new('ShaderNodeTexImage');height.image=bpy.data.images.load(str(a.maps/'Leica_Leather_Height.png'));height.image.colorspace_settings.name='Non-Color'
bump=n.new('ShaderNodeBump');bump.invert=True;bump.inputs['Distance'].default_value=.00005;l.new(height.outputs['Color'],bump.inputs['Height']);l.new(nm.outputs['Normal'],bump.inputs['Normal']);l.new(bump.outputs['Normal'],p.inputs['Normal'])
image=bpy.data.images.new('Leica leather normal plus height',width=2048,height=1024,alpha=False);image.generated_color=(.5,.5,1,1);image.colorspace_settings.name='Non-Color'
for mat in bpy.data.materials:
 if mat.use_nodes:
  t=mat.node_tree.nodes.new('ShaderNodeTexImage');t.image=image;mat.node_tree.nodes.active=t
for o in objects:
 bm=bmesh.new();bm.from_mesh(o.data);bmesh.ops.delete(bm,geom=[f for f in bm.faces if o.data.materials[f.material_index].name!='Leather_Black'],context='FACES');bm.to_mesh(o.data);bm.free()
 bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 bpy.ops.object.bake(type='NORMAL',normal_space='TANGENT',margin=8)
image.filepath_raw=str(a.maps/'Leica_Leather_Combined_Normal.png');image.file_format='PNG';image.save()
print('BAKED',len(objects))
