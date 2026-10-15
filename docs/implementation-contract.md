# Internal implementation contract

This file coordinates the first implementation. Public usage belongs in README.md.

- Python 3.12, standard library only. Package `film` at repository root.
- Pinned rendering environment: Blender 4.3.2 / Cycles, FFmpeg 7.1.5.
- Scene is JSON, `schemaVersion: 1`, canonical meters, right-handed Y-up.
- `film.scene.load_scene(path)` reads and validates a scene; `validate_scene(data)` raises ValueError.
- `film.scene.evaluate(scene, frame)` returns a deterministic frame sample. Frames start at 1; time is `(frame-1)/fps`.
- `film.scene.sample_scene(scene)` returns `{scene: scene, frames: [sample, ...]}`.
- `film.scene.scene_digest(scene)` returns canonical JSON SHA256.

Scene fields:

```text
sceneId, schemaVersion, coordinates:{units:'meters',handedness:'right',up:'Y'}
render:{blenderVersion:'4.3.2',ffmpegVersion:'7.1.5',engine:'CYCLES',seed:17,fps:24,width:1080,height:1920,samples:32}
product:{revisionId,provenance:{source,reuseBasis,owner,allowedExternalDestinations:[]},dimensionsM:[x,y,z],components:[...]}
component:{id,shape:'box'|'cylinder',sizeM:[x,y,z],assembly:{translationM:[x,y,z],rotationXyzw:[0,0,0,1]},material:{baseColor:[r,g,b,a],roughness,metallic},bevelM:0.002}
product.label:{componentId:'label',text:'MORA',subtitle:'BOTANICAL / 50 mL'}
environment:{revisionId,kind:'authored',worldColor:[r,g,b],plinth:{id:'plinth',sizeM:[x,y,z],translationM:[x,y,z]},provenance:{...}}
placement:{translationM:[0,0,0],restsOn:'plinth'}
actions:[{actionId,componentId,relativeTo,type:'lift'|'screw',axisSpace:'component-local',axis:[0,1,0],pivotM:[0,0,0],approval:'confirmed',evidenceIds:['fixture-spec-v1'],startSeconds,durationSeconds,distanceM:0.055}]
screw action replaces distanceM with turns, axialTravelPerRevolutionM, directionSign:1|-1
evidence:[{id,description}]
shots:[{id,name,startFrame,endFrame,camera:{from:{positionM:[x,y,z],targetM:[x,y,z],focalLengthMm:50},to:{positionM:[x,y,z],targetM:[x,y,z],focalLengthMm:50}}}]
```

Evaluated frame:

```json
{"frame":1,"timeSeconds":0,"shotId":"reveal","components":{"bottle-body":{"translationM":[0,0.052,0],"rotationXyzw":[0,0,0,1]}},"camera":{"positionM":[0.2,0.17,0.36],"targetM":[0,0.07,0],"focalLengthMm":50}}
```

Sample component transforms are world transforms; original assembly transforms remain in the scene. Canonical-to-Blender position is `(x,-z,y)`, with rotation conjugated by +90 degrees around X. Primitive dimensions are converted at mesh creation (cylinder's long axis is canonical Y).

`scripts/blender_scene.py --samples PATH --output DIR [--frames 1,2,3] [--width W --height H --samples-per-pixel N]`: launched as `blender --background --factory-startup --python scripts/blender_scene.py -- ...`. Build and save output/scene.blend with all sampled keyframes; render requested frame IDs as `frames/000001.png`. No --frames means build only. Also produce three stills / contact sheet through worker after complete render. Worker uses absolute paths. Renderer must reject incompatible Blender version.

Worker module `film.jobs`: `create_job(scene_path, output_dir, *, width=None, height=None, samples=None)` -> job dict written output_dir/job.json. `run_job(output_dir, *, blender='blender', ffmpeg='ffmpeg')` executes resumable rendering then verifies complete frame sequence before MP4 assembly; `cancel_job(output_dir)` records cancellation. CLI root will wrap these. Jobs record scene digest, render profile, state, completed ranges, attempt history, tools, errors. Source manifest is copied to output_dir/scene.json; samples written output_dir/samples.json. Rendering should use small batches or one worker process with cancellation checks; resume verifies existing PNGs rather than assuming filenames mean success. Never silently overwrite an output job for another scene or profile. Root CLI will implement validate, sample, init, render, resume, cancel, status.
