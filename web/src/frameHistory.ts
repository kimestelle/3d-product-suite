/** Keep editor and editorial entries on the same native history sequence. */
const key='__gessoFrameIndex';
export function frameHistoryIndex(history:History=window.history):number|null {
  const value=history.state?.[key];
  return typeof value==='number'&&Number.isSafeInteger(value)?value:null;
}
export function ensureFrameHistory(history:History=window.history):number {
  const existing=frameHistoryIndex(history);if(existing!==null)return existing;
  history.replaceState({...history.state,[key]:0},'');return 0;
}
export function pushFrameHistory(url:string,history:History=window.history) {
  const index=ensureFrameHistory(history)+1;
  history.pushState({...history.state,[key]:index},'',url);
}
export type FrameHistoryPosition={url:string;index:number|null};
/** Reverse the actual traversal when possible; never add a cancellation entry. */
export function restoreFrameHistory(position:FrameHistoryPosition,history:History=window.history):boolean {
  const current=frameHistoryIndex(history);
  if(position.index!==null&&current!==null&&position.index!==current) {
    history.go(position.index-current);return true;
  }
  history.replaceState({...history.state,[key]:position.index??current??0},'',position.url);return false;
}
