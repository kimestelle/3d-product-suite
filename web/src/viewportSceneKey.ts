/** Image-finish edits do not alter geometry, lighting, samples or GPU asset identity. */
export function viewportSceneKey(scene:any):string {
  const {postProcessing: _finish,...visual}=scene;
  return JSON.stringify(visual);
}
export function isImageFinishOnlyChange(previous:any,next:any):boolean {
  return !!previous&&!!next&&viewportSceneKey(previous)===viewportSceneKey(next);
}
