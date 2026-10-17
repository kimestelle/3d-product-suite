# Scene objects and interactions

Open **Scene** to see the product and its components, environment, floor, explicit objects and shot cameras. Select an item in the tree or click the product/object in the viewport. Camera selection opens that shot's framing controls.

New editor projects and product imports start on the floor with no generated rectangular plinth. **Add optional plinth** creates an explicit support when wanted. For saved scenes, selecting the plinth and choosing **Remove plinth** removes its geometry while retaining revision history.

## Place the product

- Choose the floor, an explicit object, or the optional plinth under **Rest product on**.
- In a mesh world, use **Pick a surface in the world** and click an upward-facing surface. The product moves there and the cameras reframe around it and visible objects.
- Adjust the offset and yaw to compose the product without changing its geometry.
- Use **Frame product and objects** after arranging a set. Each shot keeps its viewing direction and focal length.

Picked contacts are shared canonical scene coordinates, not semantic object recognition. Re-pick after replacing or realigning the world. In A/B mode, the product and objects occupy the same positions in both conditions; inspect contact in each view. Gaussian splats need a mesh representation for surface picking.

## Arrange objects

**Box** and **Cylinder** add explicit objects only when requested. Change their names, dimensions and orientation, then choose a relationship:

| Relationship | Result |
| --- | --- |
| Free placement | Use the object's absolute position. |
| On top of | Align its bottom with the target's horizontal upper bound, plus a gap. |
| Beside | Place it beyond the target's positive X bound. |
| In front of | Place it beyond the target's positive Z bound. |
| Behind | Place it beyond the target's negative Z bound. |

Related objects follow the target's rigid placement and dimensions. Gap and offset controls adjust the composition. **Rest product on this object** makes an explicit object a support; it first breaks dependencies on the product while preserving the object's position. Deleting a support removes its links, freezes dependent objects at their resolved positions, and returns the product to the floor.

Objects participate in native geometry occlusion and rendering. Render a Cycles still to inspect contact, shadows and appearance. Relations use conservative axis-aligned bounds; they do not simulate physics, detect arbitrary collisions, segment a generated world, or attach objects to animated product parts.

## Saved scene contract

`environment.floorY` declares a shared floor reference. `environment.plinth.visible=false` suppresses plinth geometry in preview and Blender. Legacy scenes without a visibility value keep their original saved plinth. `placement.restsOn` accepts `floor`, `world-surface`, the plinth ID or a visible explicit prop ID. A world contact stores `placement.contactPointM`; `placement.translationM` is the offset from the support and `rotationYDegrees` rotates the complete product assembly.

An explicit prop may store a relationship such as:

```json
{"type":"behind","targetId":"product","gapM":0.025,"offsetM":[0,0,0]}
```

Target IDs refer to the whole product (`product`), floor (`floor`), plinth ID or another prop ID. Invalid targets, hidden supports and dependency cycles are rejected. Python resolves the object graph into sampled component and prop poses consumed by both the browser and the standalone Blender renderer. Save/reopen, undo/redo, immutable render bundles and A/B comparisons preserve these relationships.

Run `RUN_BLENDER_TESTS=1 python -m unittest tests.test_scene_objects_blender -v` for native contact/pose checks. With a disposable local server on port 8792, `node web/tests/scene-objects-smoke.mjs` exercises the tree, support changes, relative placement, yaw, framing, persistence, actual mesh surface picking and a Cycles still.
