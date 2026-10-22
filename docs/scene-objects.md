# Scene objects and interactions

Open **Stage → Objects**. The object strip lists the plinth and every added object; selecting one opens its settings in the side rail. **Product placement**, below the strip, controls where the product rests.

New editor projects rest on their visible contact plinth; product imports rest on the same plinth, hidden (D93, D127). A hidden plinth that supports the product is an invisible floor at the plinth's top (D160), so saved campaigns keep their exact poses. **Show plinth** reveals it under the product without moving the product; for a product resting on the floor it stands the plinth on that floor and rests the product on its top.

## Place the product

- Under **Rests on**, choose the floor, the plinth or an added object with a level top. A hidden legacy plinth stays listed while the product uses it.
- In a mesh world, use **Pick a surface in the world** and click an upward-facing surface. The product moves there and the cameras reframe around it and visible objects.
- Adjust **Offset** and **Turn** to compose the product without changing its geometry. **Floor** sets `environment.floorY`; objects resting on the floor follow it.
- Use **Frame product and objects** after arranging a set. Each shot keeps its viewing direction and focal length.

Picked contacts are shared canonical scene coordinates, not semantic object recognition. Re-pick after replacing or realigning the world. In A/B mode, the product and objects occupy the same positions in both conditions; inspect contact in each view. Gaussian splats need a mesh representation for surface picking.

## Arrange objects

**Add box**, **Add cylinder** and the Poly Haven prop library add explicit objects only when requested. Change their names, dimensions and orientation in the side rail, then choose a **Relationship**:

| Relationship | Result |
| --- | --- |
| Free placement | Use the object's absolute position. |
| On top of | Align its bottom with the target's horizontal upper bound, plus a gap. |
| Beside | Place it beyond the target's positive X bound. |
| In front of | Place it beyond the target's positive Z bound. |
| Behind | Place it beyond the target's negative Z bound. |

Related objects follow the target's rigid placement and dimensions; their position field is replaced by the relationship's gap and offset. **Rest product on this object** makes a level object the product's support; it first breaks dependencies on the product while preserving the object's position. **Remove object** removes its links, freezes dependent objects at their resolved positions, and returns the product to the floor if it rested there.

Objects participate in native geometry occlusion and rendering. Render a Cycles still to inspect contact, shadows and appearance. Relations use conservative axis-aligned bounds; they do not simulate physics, detect arbitrary collisions, segment a generated world, or attach objects to animated product parts.

## Floors and contact

- `environment.floorY`, when present, is the floor.
- Otherwise a visible plinth stands on a floor at its bottom.
- Otherwise the hidden plinth's top is the floor, which is where a legacy product touches down.

The authored studio's curved sweep sits on that floor. The studio contact-shadow receiver and the Gaussian-world shadow catcher sit at the product's contact: the top of its plinth (shown or hidden), the floor, the picked surface, or the supporting object's top. The editor line already placed the sweep at a hidden plinth's top (D109); main's earlier rule put a hidden plinth's floor at Y 0, which equals that top for every D93 import.

## Saved scene contract

`environment.floorY` declares a shared floor reference. `environment.plinth.visible=false` suppresses plinth geometry in preview and Blender. Legacy scenes without a visibility value keep their original saved plinth. `placement.restsOn` accepts `floor`, `world-surface`, the plinth ID (visible or hidden) or a visible explicit prop ID. A world contact stores `placement.contactPointM`; `placement.translationM` is the offset from the support and `rotationYDegrees` rotates the complete product assembly. Product `placement.scale` scales the resolved product bounds used by relationships.

An explicit prop may store a relationship such as:

```json
{"type":"behind","targetId":"product","gapM":0.025,"offsetM":[0,0,0]}
```

Target IDs refer to the whole product (`product`), floor (`floor`), plinth ID or another prop ID. Invalid targets, hidden prop targets (including a hidden plinth as a prop target) and dependency cycles are rejected. Python resolves the object graph into sampled component and prop poses consumed by both the browser and the standalone Blender renderer; samples carry `props` only when the scene has props, so prop-free scenes keep byte-identical samples. Save/reopen, undo/redo, immutable render bundles and A/B comparisons preserve these relationships.

Run `RUN_BLENDER_TESTS=1 python -m unittest tests.test_scene_objects_blender -v` for native contact/pose checks; `tests.test_floor_contact` checks the floor and contact heights through the Blender adapter without Blender. `web/tests/scene-objects-smoke.mjs` was written for main's earlier editor and its **Scene** tab; it needs updating for the gesso layout before it is used again.
