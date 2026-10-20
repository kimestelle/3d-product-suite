"""Normalize masked product surfaces into parameters that can be texture baked.

This preserves both branches as spatial PBR parameters, not as a baked beauty
image. A mixture of BRDFs is still an approximation in a single glTF material.
"""
import math


def normalize_mix_surface(material, glass_shader, source_socket):
    if not material.use_nodes or material.node_tree is None:
        return False
    tree, memo, visiting = material.node_tree, {}, set()

    def fail(message):
        raise ValueError(f'Material “{material.name}”: {message}')

    def number(socket):
        value = source_socket(socket)
        if socket.is_linked and value.node.type != "VALUE":
            return None
        default = getattr(value, "default_value", None)
        return float(default) if isinstance(default, (int, float)) and math.isfinite(default) else None

    def same(a, b):
        if a.is_linked or b.is_linked:
            return a.is_linked and b.is_linked and source_socket(a).as_pointer() == source_socket(b).as_pointer()
        av, bv = a.default_value, b.default_value
        if isinstance(av, (int, float)):
            return math.isclose(av, bv, rel_tol=1e-6, abs_tol=1e-7)
        return all(math.isclose(x, y, rel_tol=1e-6, abs_tol=1e-7) for x, y in zip(av, bv))

    def copy(a, b):
        if a.is_linked:
            tree.links.new(a.links[0].from_socket, b)
        else:
            b.default_value = a.default_value

    def blend(a, b, target, factor):
        if same(a, b):
            copy(a, target)
            return
        node = tree.nodes.new("ShaderNodeMixRGB")
        node.blend_type = "MIX"
        node.use_clamp = False
        node.label = "Imported surface " + target.name
        copy(factor, node.inputs[0])
        for source, destination in ((a, node.inputs[1]), (b, node.inputs[2])):
            if source.is_linked:
                tree.links.new(source.links[0].from_socket, destination)
            elif target.name == "Normal":
                # An unlinked BSDF normal means the geometric shading normal,
                # not a zero vector. Bake the resulting world-normal mixture
                # back into tangent space on the evaluated mesh.
                geometry = tree.nodes.new("ShaderNodeNewGeometry")
                tree.links.new(geometry.outputs["Normal"], destination)
            elif isinstance(source.default_value, (int, float)):
                destination.default_value = (source.default_value,) * 3 + (1,)
            else:
                destination.default_value = source.default_value
        tree.links.new(node.outputs[0], target)

    def resolve(socket, depth=0):
        if not socket.is_linked:
            fail("the Mix Shader has an empty branch. Connect both surface shaders before importing.")
        node = source_socket(socket).node
        pointer = node.as_pointer()
        if pointer in memo:
            return memo[pointer]
        if pointer in visiting or depth > 16:
            fail("the surface shader graph is cyclic or exceeds 16 nested mixes.")
        if node.type == "BSDF_PRINCIPLED":
            return node
        if node.type == "BSDF_GLASS":
            result = glass_shader(material, node)
            memo[pointer] = result
            return result
        if node.type != "MIX_SHADER":
            fail(f'Mix Shader branch “{node.name}” uses {node.type}. Automatic masked conversion supports Principled BSDF and Glass BSDF branches.')
        visiting.add(pointer)
        factor = number(node.inputs[0])
        if factor is not None and (factor <= 0 or factor >= 1):
            result = resolve(node.inputs[1 if factor <= 0 else 2], depth + 1)
        else:
            first, second = resolve(node.inputs[1], depth + 1), resolve(node.inputs[2], depth + 1)
            # IOR cannot vary spatially in glTF. Do not average two optical media.
            iors = [number(shader.inputs["IOR"]) for shader in (first, second)]
            if any(value is None or value < 1 for value in iors) or not math.isclose(*iors, rel_tol=1e-6, abs_tol=1e-6):
                fail("mixed surfaces need the same numeric IOR; glTF cannot store spatially varying refraction.")
            # These lobes do not exist in our six-channel masked surface bake.
            # Reject active differences instead of silently flattening them.
            for shader in (first, second):
                for name in ("Subsurface Weight", "Coat Weight", "Sheen Weight", "Anisotropic", "Emission Strength", "Thin Film Thickness"):
                    if number(shader.inputs[name]) != 0:
                        fail(f'mixed {name.lower()} is not supported. Use a single Principled surface for that effect.')
            result = tree.nodes.new("ShaderNodeBsdfPrincipled")
            result.label = "Imported masked surface"
            result.inputs["IOR"].default_value = iors[0]
            for name in ("Specular IOR Level", "Specular Tint"):
                if not same(first.inputs[name], second.inputs[name]):
                    fail(f'mixed surfaces need matching {name.lower()} settings for this conversion.')
                copy(first.inputs[name], result.inputs[name])
            for name in ("Base Color", "Metallic", "Roughness", "Transmission Weight", "Alpha", "Normal"):
                blend(first.inputs[name], second.inputs[name], result.inputs[name], node.inputs[0])
        visiting.remove(pointer)
        memo[pointer] = result
        return result

    changed = False
    for output in list(tree.nodes):
        if output.type != "OUTPUT_MATERIAL" or not output.is_active_output:
            continue
        surface = output.inputs["Surface"]
        if surface.is_linked and source_socket(surface).node.type == "MIX_SHADER":
            shader = resolve(surface)
            tree.links.new(shader.outputs["BSDF"], surface)
            changed = True
    return changed
