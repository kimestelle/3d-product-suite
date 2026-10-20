import {cameraBaseForSharedMotion, filmCameraPoseAtFrame, retimeMotions, validateFilmMotions} from './filmMotion';
export type ImageShotAsset = {path: string; sha256: string; format: 'png' | 'jpeg' | 'webp'; width: number; height: number};
export type Shot = {id: string; name: string; startFrame: number; endFrame: number; camera: any;
  kind?: 'scene' | 'image'; image?: {asset: ImageShotAsset; fit: 'contain' | 'cover'}; [key: string]: any};

export function shotFrames(shot: Shot): number { return shot.endFrame - shot.startFrame + 1; }
/** Display and playback share this exact shot lookup. */
export function exactShotAtFrame(scene: any, frame: number): Shot | undefined {
  return scene.shots.find((shot: Shot) => frame >= shot.startFrame && frame <= shot.endFrame);
}
/** Keep the legacy camera/editing fallback separate from visible timeline content. */
export function shotAtFrame(scene: any, frame: number): Shot {
  return exactShotAtFrame(scene, frame) ?? scene.shots.at(-1);
}
const contentEnd = (shots: Pick<Shot, 'endFrame'>[]): number => Math.max(1, ...shots.map(shot => shot.endFrame));
export function sequenceEnd(scene: any): number { return scene.render?.durationFrames ?? contentEnd(scene.shots ?? []); }

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`);
}

function validateImageAsset(asset: ImageShotAsset) {
  if (!asset || typeof asset.path !== 'string' || !asset.path.trim() || asset.path.includes('\0')) throw new Error('Choose an imported image file.');
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error('The image needs a verified file fingerprint. Import it again.');
  if (!['png', 'jpeg', 'webp'].includes(asset.format)) throw new Error('Choose a PNG, JPEG or WebP image.');
  positiveInteger(asset.width, 'Image width'); positiveInteger(asset.height, 'Image height');
}

function checkedShots(shots: Shot[], totalFrames: number): Shot[] {
  positiveInteger(totalFrames, 'Movie length');
  if (!shots.length) throw new Error('Keep at least one shot in the film.');
  const ids = new Set<string>(), next = structuredClone(shots).sort((a, b) => a.startFrame - b.startFrame);
  let previous: Shot | undefined;
  for (const shot of next) {
    positiveInteger(shot.startFrame, 'Shot start'); positiveInteger(shot.endFrame, 'Shot end');
    positiveInteger(shotFrames(shot), 'Shot length');
    if (!shot.id || ids.has(shot.id)) throw new Error('Each shot needs a unique ID.');
    ids.add(shot.id);
    if (previous && shot.startFrame <= previous.endFrame) throw new Error(`“${shot.name || shot.id}” overlaps “${previous.name || previous.id}”. Move or shorten a shot to leave enough space.`);
    if (shot.endFrame > totalFrames) throw new Error(`“${shot.name || shot.id}” ends at frame ${shot.endFrame}. Keep at least ${shot.endFrame} frames, or move or shorten that shot first.`);
    if (shot.kind !== undefined && !['scene', 'image'].includes(shot.kind)) throw new Error('Choose a scene or image shot.');
    if (shot.kind === 'image') {
      if (!shot.image || !['contain', 'cover'].includes(shot.image.fit)) throw new Error('Choose contain or cover for the image.');
      validateImageAsset(shot.image.asset);
    }
    previous = shot;
  }
  return next;
}

export function checkActionCoverage(scene: any, totalFrames: number, fps = scene.render.fps) {
  const lastTime = (totalFrames - 1) / fps;
  for (const action of scene.actions ?? []) {
    const end = action.startSeconds + action.durationSeconds;
    if (end > lastTime) {
      const minimumFrames = Math.ceil(end * fps) + 1;
      throw new Error(`${action.componentId} movement ends at ${Number(end.toFixed(3))} s. Keep at least ${minimumFrames} frames, or shorten the movement in Film / Animation first.`);
    }
  }
}


export function checkKeyframeCoverage(scene: any, totalFrames: number) {
  let last: {frame: number; componentId: string; property: string} | undefined;
  for (const track of scene.animation?.tracks ?? []) {
    for (const key of track.keys) {
      if (!last || key.frame > last.frame) last = {frame: key.frame, componentId: track.componentId, property: track.property};
    }
  }
  if (last && last.frame > totalFrames) {
    const target = last.componentId === '$product' ? 'Product' : last.componentId;
    throw new Error(`${target} ${last.property} has its last key at frame ${last.frame}. Keep at least ${last.frame} frames, or move or remove that key in Film / Animation first.`);
  }
}

/** Cuts are adjacent. The clip order and lengths define the film clock. */
function contiguousShots(shots: Shot[]): Shot[] {
  let start = 1;
  return structuredClone(shots).map(shot => {
    const frames = shotFrames(shot); positiveInteger(frames, 'Shot length');
    shot.startFrame = start; shot.endFrame = start + frames - 1; start = shot.endFrame + 1;
    return shot;
  });
}

function commitShots(scene: any, shots: Shot[]) {
  const packed = contiguousShots(shots), totalFrames = contentEnd(packed);
  const next = checkedShots(packed, totalFrames);
  checkActionCoverage(scene, totalFrames); checkKeyframeCoverage(scene, totalFrames);
  for (const motion of scene.motions ?? []) {
    const end = motion.startFrame + motion.durationFrames - 1;
    if (end > totalFrames) throw new Error(`Across-cuts movement ends at frame ${end}. Shorten that movement before removing this time.`);
  }
  validateFilmMotions({...scene, shots: next});
  scene.shots = next;
  if (scene.render.durationFrames !== undefined) scene.render.durationFrames = totalFrames;
}

function retimeGlobalContent(scene: any, ratio: number, totalFrames: number) {
  const lastTime = (totalFrames - 1) / scene.render.fps;
  if (ratio <= 0 && scene.actions?.length) throw new Error('Movement needs at least two frames. Keep a longer movie.');
  for (const action of scene.actions ?? []) {
    action.startSeconds *= ratio; action.durationSeconds *= ratio;
    // A final sample must not fall outside the reel due to floating-point addition.
    const end = action.startSeconds + action.durationSeconds;
    if (end > lastTime && end - lastTime < 1e-9) action.durationSeconds = lastTime - action.startSeconds - Number.EPSILON * Math.max(1, lastTime);
    if (action.durationSeconds < 1e-9) throw new Error('Movement would be too short. Keep a longer movie.');
  }
  for (const track of scene.animation?.tracks ?? []) {
    let previous = 0;
    for (const key of track.keys) {
      key.frame = Math.round((key.frame - 1) * ratio) + 1;
      if (key.frame <= previous) throw new Error('Animation keys would overlap. Keep a longer movie or separate those keys first.');
      previous = key.frame;
    }
  }
  for (const motion of scene.motions ?? []) {
    const start = motion.startFrame;
    const mappedStart = Math.round((start - 1) * ratio) + 1;
    const mappedEnd = Math.round((start + motion.durationFrames - 2) * ratio) + 1;
    motion.startFrame = mappedStart; motion.durationFrames = mappedEnd - mappedStart + 1;
    if (motion.durationFrames < 2) throw new Error('A motion would collapse to one frame. Keep a longer movie.');
    let previous = 0;
    for (const key of motion.keys ?? []) {
      key.frame = Math.round((start + key.frame - 2) * ratio) + 2 - mappedStart;
      if (key.frame <= previous) throw new Error('Motion curve keys would overlap. Keep a longer movie or separate those keys first.');
      previous = key.frame;
    }
  }
}

function applyTiming(scene: any, draft: any) {
  if (draft.shots.length) commitShots(draft, draft.shots);
  else {
    // Legacy empty movies remain editable until their first scene is inserted.
    checkActionCoverage(draft, sequenceEnd(draft)); checkKeyframeCoverage(draft, sequenceEnd(draft));
    validateFilmMotions(draft);
  }
  scene.shots = draft.shots; scene.render = draft.render;
  if (draft.actions) scene.actions = draft.actions;
  if (draft.animation) scene.animation = draft.animation;
  if (draft.motions) scene.motions = draft.motions;
}

/** Existing gap experiments open as one recoverable, continuous edit. */
export function closeSequenceGaps(scene: any): boolean {
  if (!scene.shots.length) return false;
  const ordered = [...scene.shots].sort((a: Shot, b: Shot) => a.startFrame - b.startFrame);
  const packed = contiguousShots(ordered), total = contentEnd(packed), previous = sequenceEnd(scene);
  if (total === previous && ordered.every((shot: Shot, index: number) => scene.shots[index].id === shot.id && shot.startFrame === packed[index].startFrame && shot.endFrame === packed[index].endFrame)) return false;
  const draft = structuredClone(scene); draft.shots = packed;
  if (previous > 1) retimeGlobalContent(draft, (total - 1) / (previous - 1), total);
  applyTiming(scene, draft); return true;
}

/** Movie duration stretches its footage and motion together, without blank time. */
export function setSequenceFrames(scene: any, frames: number) {
  positiveInteger(frames, 'Movie length');
  const draft = structuredClone(scene); closeSequenceGaps(draft);
  const previous = sequenceEnd(draft), clips = draft.shots as Shot[];
  if (!clips.length) {
    if (previous > 1) retimeGlobalContent(draft, (frames - 1) / (previous - 1), frames);
    draft.render.durationFrames = frames; applyTiming(scene, draft); return;
  }
  if (frames < clips.length) throw new Error('Keep at least one frame for every scene.');
  if (frames === previous) {applyTiming(scene, draft); return;}
  let oldBoundary = 0, newBoundary = 0;
  for (const shot of clips) {
    const oldLength = shotFrames(shot); oldBoundary += oldLength;
    const end = Math.round(oldBoundary / previous * frames), length = end - newBoundary;
    if (length < 1) throw new Error(`“${shot.name || shot.id}” would collapse. Keep a longer movie.`);
    const ratio = oldLength > 1 ? (length - 1) / (oldLength - 1) : 1;
    const motions = retimeMotions(shot.motions, ratio);
    if (motions) shot.motions = motions;
    if (shot.camera.durationFrames !== undefined) shot.camera.durationFrames = Math.max(1, Math.round((shot.camera.durationFrames - 1) * ratio) + 1);
    shot.startFrame = newBoundary + 1; shot.endFrame = end; newBoundary = end;
  }
  if (previous > 1) retimeGlobalContent(draft, (frames - 1) / (previous - 1), frames);
  draft.render.durationFrames = frames;
  applyTiming(scene, draft);
}

function shotIndex(scene: any, id: string): number {
  const index = scene.shots.findIndex((shot: Shot) => shot.id === id);
  if (index < 0) throw new Error('This shot is no longer in the film.');
  return index;
}

function newId(scene: any): string {
  const ids = new Set(scene.shots.map((shot: Shot) => shot.id));
  let index = 1;
  while (ids.has(`shot-${index}`)) index += 1;
  return `shot-${index}`;
}

export function setShotFrames(scene: any, id: string, frames: number) {
  positiveInteger(frames, 'Shot length');
  const index = shotIndex(scene, id);
  const shots = structuredClone(scene.shots) as Shot[];
  if (frames !== shotFrames(shots[index])) shots[index].camera.durationFrames ??= shotFrames(shots[index]);
  shots[index].endFrame = shots[index].startFrame + frames - 1;
  commitShots(scene, shots);
}

/** Stretch the authored performance explicitly; ordinary shot length edits only trim. */
export function stretchShotFrames(scene: any, id: string, frames: number) {
  positiveInteger(frames, 'Shot length');
  const index = shotIndex(scene, id), previous = shotFrames(scene.shots[index]);
  if (frames < 2 || previous < 2) throw new Error('Stretching needs at least two frames in both durations.');
  const shots = structuredClone(scene.shots) as Shot[];
  const motions = retimeMotions(shots[index].motions, (frames - 1) / (previous - 1));
  if (motions) shots[index].motions = motions;
  const cameraDuration = shots[index].camera.durationFrames ?? previous;
  shots[index].camera.durationFrames = Math.round((cameraDuration - 1) * (frames - 1) / (previous - 1)) + 1;
  shots[index].endFrame = shots[index].startFrame + frames - 1;
  commitShots(scene, shots);
}

/** Insert one clip at the cut and ripple everything after it. */
function insertAfter(scene: any, index: number, shot: Shot) {
  const shots = structuredClone(scene.shots) as Shot[];
  shots.splice(index + 1, 0, shot);
  commitShots(scene, shots);
}

/** Matches the canonical sampler's camera when an empty movie has no framing yet. */
function initialCamera() {
  const pose = {positionM: [0, .2, 1], targetM: [0, .1, 0], focalLengthMm: 50};
  return {from: structuredClone(pose), to: structuredClone(pose)};
}

function insertionIndex(scene: any, afterId?: string): number {
  return !scene.shots.length && afterId === undefined ? -1 : shotIndex(scene, afterId ?? scene.shots.at(-1)?.id);
}

export function addShot(scene: any, afterId?: string): string {
  const index = insertionIndex(scene, afterId);
  const previous = scene.shots[index];
  const id = newId(scene);
  const camera = previous ? structuredClone(previous.camera) : initialCamera();
  if (previous) {
    const endpoint = filmCameraPoseAtFrame(scene, previous, previous.endFrame);
    const pose = cameraBaseForSharedMotion(scene, previous.endFrame + 1, endpoint);
    camera.from = structuredClone(pose); camera.to = structuredClone(pose);
  }
  delete camera.durationFrames;
  const duration = previous ? scene.render.fps * 3 : Math.max(scene.render.fps * 3, sequenceEnd(scene));
  const shot: Shot = {id, name: `Shot ${scene.shots.length + 1}`, startFrame: 1, endFrame: duration, camera};
  insertAfter(scene, index, shot);
  return id;
}

/** Insert an image after the selected scene, or append it by default. */
export function addImageShot(scene: any, asset: ImageShotAsset, name: string, afterId = scene.shots.at(-1)?.id,
  durationFrames = scene.shots.length ? scene.render.fps * 3 : Math.max(scene.render.fps * 3, sequenceEnd(scene))): string {
  validateImageAsset(asset); positiveInteger(durationFrames, 'Shot length');
  const index = insertionIndex(scene, afterId), previous = scene.shots[index], id = newId(scene);
  const shot: Shot = {id, name: name.trim().slice(0, 80) || 'Image', kind: 'image', startFrame: 1,
    endFrame: durationFrames, camera: previous ? structuredClone(previous.camera) : initialCamera(), image: {asset: structuredClone(asset), fit: 'contain'}};
  delete shot.camera.durationFrames;
  insertAfter(scene, index, shot);
  return id;
}

export function duplicateShot(scene: any, id: string): string {
  const index = shotIndex(scene, id);
  const copy = structuredClone(scene.shots[index]);
  copy.id = newId(scene);
  copy.name = `${copy.name || 'Shot'} copy`;
  const motionIds = new Set([...(scene.motions ?? []), ...scene.shots.flatMap((shot: Shot) => shot.motions ?? [])].map((motion: any) => motion.id));
  for (const motion of copy.motions ?? []) {
    let index = 1;
    while (motionIds.has(`motion-${index}`)) index++;
    motion.id = `motion-${index}`; motionIds.add(motion.id);
  }
  insertAfter(scene, index, copy);
  return copy.id;
}

export function removeShot(scene: any, id: string): string {
  const index = shotIndex(scene, id);
  const shots = scene.shots.filter((shot: Shot) => shot.id !== id);
  commitShots(scene, shots);
  return scene.shots[Math.min(index, scene.shots.length - 1)].id;
}

/** Move a whole scene or image to its final zero-based position, keeping adjacent cuts. */
export function reorderShot(scene: any, id: string, targetIndex: number): boolean {
  const index = shotIndex(scene, id);
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= scene.shots.length) {
    throw new Error('Choose a position within the film.');
  }
  if (index === targetIndex) return false;
  const shots = structuredClone(scene.shots) as Shot[];
  const [shot] = shots.splice(index, 1);
  shots.splice(targetIndex, 0, shot);
  commitShots(scene, shots);
  return true;
}

export function moveShot(scene: any, id: string, direction: -1 | 1) {
  const index = shotIndex(scene, id);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= scene.shots.length) return;
  reorderShot(scene, id, nextIndex);
}

export function setFrameRate(scene: any, fps: number) {
  positiveInteger(fps, 'Frame rate');
  const ratio = fps / scene.render.fps;
  const shots = scene.shots.map((shot: Shot) => {
    const result: Shot = {...structuredClone(shot), startFrame: Math.round((shot.startFrame - 1) * ratio) + 1, endFrame: Math.round(shot.endFrame * ratio)};
    if (result.endFrame < result.startFrame) throw new Error(`“${shot.name || shot.id}” would collapse at ${fps} fps. Keep a higher frame rate or lengthen that shot first.`);
    if (shot.motions) result.motions = retimeMotions(shot.motions, ratio);
    if (shot.camera.durationFrames !== undefined) result.camera.durationFrames = Math.round((shot.camera.durationFrames - 1) * ratio) + 1;
    return result;
  });
  const totalFrames = Math.max(1, Math.round(sequenceEnd(scene) * ratio));
  const next = checkedShots(shots, totalFrames);
  const animation = scene.animation ? structuredClone(scene.animation) : undefined;
  for (const track of animation?.tracks ?? []) {
    let previous = 0;
    for (const key of track.keys) {
      const sourceFrame = key.frame;
      let frame = Math.round((sourceFrame - 1) * ratio) + 1;
      // A reel's final sample can round one frame past its rounded duration
      // when reducing FPS. Keep that endpoint on the new final sample only.
      if (sourceFrame === sequenceEnd(scene) && frame === totalFrames + 1) frame = totalFrames;
      if (frame <= previous) {
        const target = track.componentId === '$product' ? 'Product' : track.componentId;
        throw new Error(`${target} ${track.property} keys would overlap at frame ${frame} at ${fps} fps. Keep a higher frame rate, or separate those keys in Film / Animation first.`);
      }
      previous = frame;
      key.frame = frame;
    }
  }
  const motions = retimeMotions(scene.motions, ratio);
  checkActionCoverage(scene, totalFrames, fps);
  checkKeyframeCoverage({...scene, animation}, totalFrames);
  validateFilmMotions({...scene, shots: next, motions});
  scene.render.fps = fps;
  if (scene.render.durationFrames !== undefined) scene.render.durationFrames = totalFrames;
  scene.shots = next;
  if (animation) scene.animation = animation;
  if (motions) scene.motions = motions;
}

export function setOutputDimensions(scene: any, width: number, height: number) {
  positiveInteger(width, 'Width'); positiveInteger(height, 'Height');
  if (width % 2 || height % 2) throw new Error('Use even pixel dimensions for H.264 export.');
  if (width > 8192 || height > 8192) throw new Error('The local editor supports output up to 8192 pixels per side.');
  scene.render.width = width;
  scene.render.height = height;
}
