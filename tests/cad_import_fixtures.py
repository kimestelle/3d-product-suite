import sys
from pathlib import Path
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.IGESCAFControl import IGESCAFControl_Writer
from OCP.Interface import Interface_Static
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorGen
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Trsf,gp_Vec,gp_Pnt
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
# Asymmetric mm box, translated away from origin so centering is also tested.
w=STEPControl_Writer();w.Transfer(BRepPrimAPI_MakeBox(gp_Pnt(7,11,13),10,20,30).Shape(),STEPControl_AsIs);w.Write(str(root/'box-mm.step'))
# Same numeric STEP coordinates with an explicit metre unit exercises reader
# unit scaling independently of a writer doing its own mm↔inch conversion.
s=(root/'box-mm.step').read_text();assert 'SI_UNIT(.MILLI.,.METRE.)' in s
(root/'box-m.stp').write_text(s.replace('SI_UNIT(.MILLI.,.METRE.)','SI_UNIT($,.METRE.)'))
# Named repeated parts with assembly placements and display colours.
doc=TDocStd_Document(TCollection_ExtendedString('BinXCAF'));XCAFDoc_DocumentTool.SetLengthUnit_s(doc,.001)
tool=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());colors=XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
compound=TopoDS_Compound();BRep_Builder().MakeCompound(compound)
assembly=tool.AddShape(compound,True);TDataStd_Name.Set_s(assembly,TCollection_ExtendedString('Bottle assembly'))
part=tool.AddShape(BRepPrimAPI_MakeBox(10,20,30).Shape(),False);TDataStd_Name.Set_s(part,TCollection_ExtendedString('Cap'))
colors.SetColor(part,Quantity_Color(.8,.1,.2,Quantity_TOC_RGB),XCAFDoc_ColorGen)
for index,xyz in enumerate(((0,0,0),(40,5,7))):
 t=gp_Trsf();t.SetTranslation(gp_Vec(*xyz));child=tool.AddComponent(assembly,part,TopLoc_Location(t));TDataStd_Name.Set_s(child,TCollection_ExtendedString(f'Cap {index+1}'))
tool.UpdateAssemblies();w=STEPCAFControl_Writer();w.Transfer(doc);w.Write(str(root/'assembly.step'))
w=IGESCAFControl_Writer();assert w.Transfer(doc);w.Write(str(root/'assembly.igs'))
# Surface-only triangle, non-coplanar with XY so each dimension is nonzero.
doc2=TDocStd_Document(TCollection_ExtendedString('BinXCAF'));XCAFDoc_DocumentTool.SetLengthUnit_s(doc2,.001)
p=BRepBuilderAPI_MakePolygon(gp_Pnt(0,0,0),gp_Pnt(10,0,5),gp_Pnt(0,20,30),True)
shape=BRepBuilderAPI_MakeFace(p.Wire()).Face();st=XCAFDoc_DocumentTool.ShapeTool_s(doc2.Main());label=st.AddShape(shape,False);TDataStd_Name.Set_s(label,TCollection_ExtendedString('Sheet'))
w=IGESCAFControl_Writer();assert w.Transfer(doc2);w.Write(str(root/'sheet.iges'))
# Unitless mesh with asymmetric physical axes and negative-index quad faces.
(root/'box.obj').write_text('''o Box\nv 7 11 13\nv 17 11 13\nv 17 31 13\nv 7 31 13\nv 7 11 43\nv 17 11 43\nv 17 31 43\nv 7 31 43\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf -5 -8 -4 -1\n''')
(root/'missing-material.obj').write_text('mtllib missing.mtl\n'+(root/'box.obj').read_text())
# One tilted triangle makes a useful ASCII STL orientation/units fixture.
(root/'sheet.stl').write_text('''solid Sheet\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 5\nvertex 0 20 30\nendloop\nendfacet\nendsolid Sheet\n''')
