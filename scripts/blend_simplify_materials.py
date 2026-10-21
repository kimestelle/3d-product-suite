"""Rewrite legacy node materials into Principled BSDFs so a .blend survives Gesso's static import.

Run inside Blender: blender --background in.blend --python blend_simplify_materials.py -- out.blend
Glass BSDF surfaces are kept. Every other material is replaced by one Principled BSDF that
salvages the first colour (image texture or value) and roughness it finds; Glossy and
Anisotropic surfaces become metallic. Tangent and other unsupported nodes are dropped.
"""
import sys
import bpy

METALLIC = {"BSDF_GLOSSY", "BSDF_ANISOTROPIC", "BSDF_METALLIC"}
KEEP = {"BSDF_PRINCIPLED", "BSDF_GLASS", "OUTPUT_MATERIAL", "TEX_IMAGE", "TEX_COORD", "MAPPING", "NORMAL_MAP", "REROUTE", "MIX_SHADER", "VALUE", "RGB", "UVMAP"}


def surface_node(tree):
    output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None) or next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if not output or not output.inputs["Surface"].links:
        return output, None
    return output, output.inputs["Surface"].links[0].from_node


def first_color(node, depth=0):
    """Image texture node feeding a colour input, or a flat colour, searching upstream."""
    if node is None or depth > 6:
        return None, None
    for name in ("Base Color", "Color", "Color1"):
        sock = node.inputs.get(name)
        if sock is None:
            continue
        if sock.links:
            upstream = sock.links[0].from_node
            if upstream.type == "TEX_IMAGE" and upstream.image:
                return upstream, None
            image, color = first_color(upstream, depth + 1)
            if image or color:
                return image, color
        else:
            return None, tuple(sock.default_value)[:4]
    return None, None


def first_roughness(node):
    sock = node.inputs.get("Roughness") if node else None
    return float(sock.default_value) if sock is not None and not sock.links else 0.45


def needs_rewrite(tree):
    output, surface = surface_node(tree)
    if surface is None:
        return True
    if surface.type in ("BSDF_PRINCIPLED", "BSDF_GLASS"):
        return any(n.type == "TANGENT" or n.type in METALLIC for n in tree.nodes) or any(l.from_node.type not in KEEP for l in tree.links)
    return True


def rewrite(material):
    tree = material.node_tree
    output, surface = surface_node(tree)
    metallic = 1.0 if surface is not None and (surface.type in METALLIC or any(n.type in METALLIC for n in tree.nodes)) else 0.0
    if surface is not None and surface.type == "BSDF_PRINCIPLED":
        metallic = float(surface.inputs["Metallic"].default_value) if not surface.inputs["Metallic"].links else 1.0
    image, color = first_color(surface)
    roughness = first_roughness(surface)
    keep = image.name if image is not None else None
    for node in list(tree.nodes):
        if node.name != keep:
            tree.nodes.remove(node)
    image = tree.nodes.get(keep) if keep else None
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = max(0.05, min(1.0, roughness))
    lowered = material.name.lower()
    dark = any(word in lowered for word in ("black", "dark", "rubber", "leather", "tyre", "tire"))
    metal = any(word in lowered for word in ("metal", "chrome", "steel", "brass", "gold", "silver", "screw", "aluminium", "aluminum"))
    glass = any(word in lowered for word in ("glass", "lens"))
    if image is not None:
        tree.links.new(image.outputs["Color"], principled.inputs["Base Color"])
    elif color is not None and not (dark or metal or glass) and max(color[:3]) < 0.98:
        principled.inputs["Base Color"].default_value = color
    elif dark:
        principled.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
    elif metal:
        principled.inputs["Base Color"].default_value = (0.78, 0.78, 0.76, 1); principled.inputs["Metallic"].default_value = 1.0
        principled.inputs["Roughness"].default_value = min(principled.inputs["Roughness"].default_value, 0.3)
    elif glass:
        principled.inputs["Base Color"].default_value = (0.9, 0.95, 1.0, 1); principled.inputs["Roughness"].default_value = 0.05
    elif color is not None:
        principled.inputs["Base Color"].default_value = color
    tree.links.new(principled.outputs["BSDF"], out.inputs["Surface"])
    return f"{material.name}: Principled (metallic {metallic:.0f}, roughness {roughness:.2f}, {'image' if image else 'colour'})"


def main():
    destination = sys.argv[sys.argv.index("--") + 1]
    changed = []
    for material in bpy.data.materials:
        if not material.use_nodes or material.node_tree is None:
            material.use_nodes = True
        if needs_rewrite(material.node_tree):
            changed.append(rewrite(material))
    # Studio setup objects (floors, light cards, backdrops) are tagged so Gesso leaves them out of the product.
    setup_words = ("свет", "пол", "light", "floor", "ground", "plane", "backdrop", "wall", "table", "stage", "camera")
    tagged = []
    for obj in bpy.data.objects:
        lowered = obj.name.lower()
        if obj.type in ("LIGHT", "CAMERA") or any(word in lowered for word in setup_words):
            obj["gesso_role"] = "environment"; tagged.append(obj.name)
    print("TAGGED environment:", tagged)
    # Make instances real and drop particle systems so the static importer accepts the scene.
    for obj in list(bpy.data.objects):
        for modifier in list(obj.modifiers):
            if modifier.type == "PARTICLE_SYSTEM":
                obj.modifiers.remove(modifier)
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=destination, compress=False)
    print("SIMPLIFIED", len(changed), "materials")
    for line in changed:
        print("  ", line)


main()
