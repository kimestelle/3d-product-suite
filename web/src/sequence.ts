export type Shot = {id: string; name: string; startFrame: number; endFrame: number; camera: any; [key: string]: any};

export function shotFrames(shot: Shot): number { return shot.endFrame - shot.startFrame + 1; }
export function shotAtFrame(scene: any, frame: number): Shot {
  return scene.shots.find((shot: Shot) => frame >= shot.startFrame && frame <= shot.endFrame) ?? scene.shots.at(-1);
}
export function sequenceEnd(scene: any): number { return scene.shots.at(-1)?.endFrame ?? 1; }

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`);
}

function arranged(shots: Shot[]): Shot[] {
  if (!shots.length) throw new Error('Keep at least one shot in the film.');
  const ids = new Set<string>();
  let nextFrame = 1;
  return shots.map(shot => {
    const duration = shotFrames(shot);
    positiveInteger(duration, 'Shot length');
    if (!shot.id || ids.has(shot.id)) throw new Error('Each shot needs a unique ID.');
    ids.add(shot.id);
    const result = {...structuredClone(shot), startFrame: nextFrame, endFrame: nextFrame + duration - 1};
    nextFrame = result.endFrame + 1;
    return result;
  });
}

export function checkActionCoverage(scene: any, totalFrames: number, fps = scene.render.fps) {
  const lastTime = (totalFrames - 1) / fps;
  for (const action of scene.actions ?? []) {
    const end = action.startSeconds + action.durationSeconds;
    if (end > lastTime) {
      const minimumFrames = Math.ceil(end * fps) + 1;
      throw new Error(`${action.componentId} movement ends at ${Number(end.toFixed(3))} s. Keep at least ${minimumFrames} frames, or shorten the movement in Product / Animation first.`);
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
    throw new Error(`${target} ${last.property} has its last key at frame ${last.frame}. Keep at least ${last.frame} frames, or move or remove that key in Product / Animation first.`);
  }
}

function commitShots(scene: any, shots: Shot[]) {
  const next = arranged(shots);
  checkActionCoverage(scene, next.at(-1)!.endFrame);
  checkKeyframeCoverage(scene, next.at(-1)!.endFrame);
  scene.shots = next;
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
  shots[index].endFrame = shots[index].startFrame + frames - 1;
  commitShots(scene, shots);
}

export function addShot(scene: any, afterId: string): string {
  const index = shotIndex(scene, afterId);
  const previous = scene.shots[index];
  const id = newId(scene);
  const pose = previous.camera.to;
  const shot: Shot = {id, name: `Shot ${scene.shots.length + 1}`, startFrame: 1, endFrame: scene.render.fps * 3,
    camera: {from: structuredClone(pose), to: structuredClone(pose)}};
  const shots = [...scene.shots];
  shots.splice(index + 1, 0, shot);
  commitShots(scene, shots);
  return id;
}

export function duplicateShot(scene: any, id: string): string {
  const index = shotIndex(scene, id);
  const copy = structuredClone(scene.shots[index]);
  copy.id = newId(scene);
  copy.name = `${copy.name || 'Shot'} copy`;
  const shots = [...scene.shots];
  shots.splice(index + 1, 0, copy);
  commitShots(scene, shots);
  return copy.id;
}

export function removeShot(scene: any, id: string): string {
  const index = shotIndex(scene, id);
  const shots = scene.shots.filter((shot: Shot) => shot.id !== id);
  commitShots(scene, shots);
  return scene.shots[Math.min(index, scene.shots.length - 1)].id;
}

export function moveShot(scene: any, id: string, direction: -1 | 1) {
  const index = shotIndex(scene, id);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= scene.shots.length) return;
  const shots = [...scene.shots];
  [shots[index], shots[nextIndex]] = [shots[nextIndex], shots[index]];
  commitShots(scene, shots);
}

export function setFrameRate(scene: any, fps: number) {
  positiveInteger(fps, 'Frame rate');
  const ratio = fps / scene.render.fps;
  let boundary = 0;
  const shots = scene.shots.map((shot: Shot) => {
    const nextBoundary = Math.max(boundary + 1, Math.round(shot.endFrame * ratio));
    const result = {...shot, startFrame: boundary + 1, endFrame: nextBoundary};
    boundary = nextBoundary;
    return result;
  });
  const next = arranged(shots);
  const totalFrames = next.at(-1)!.endFrame;
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
        throw new Error(`${target} ${track.property} keys would overlap at frame ${frame} at ${fps} fps. Keep a higher frame rate, or separate those keys in Product / Animation first.`);
      }
      previous = frame;
      key.frame = frame;
    }
  }
  checkActionCoverage(scene, totalFrames, fps);
  checkKeyframeCoverage({...scene, animation}, totalFrames);
  scene.render.fps = fps;
  scene.shots = next;
  if (animation) scene.animation = animation;
}

export function setOutputDimensions(scene: any, width: number, height: number) {
  positiveInteger(width, 'Width'); positiveInteger(height, 'Height');
  if (width % 2 || height % 2) throw new Error('Use even pixel dimensions for H.264 export.');
  if (width > 8192 || height > 8192) throw new Error('The local editor supports output up to 8192 pixels per side.');
  scene.render.width = width;
  scene.render.height = height;
}
