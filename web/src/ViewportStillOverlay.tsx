import {useEffect, useId, useRef, useState} from 'react';
import './viewport-still.css';

export type ViewportStillCapture = {blob: Blob; width: number; height: number};
export interface ViewportStillProps {
  scopeKey: unknown;
  disabledReason: string;
  onRender: (signal: AbortSignal) => Promise<ViewportStillCapture>;
  onPresent?: (showing: boolean) => void;
}
type StillState = {
  phase: 'idle' | 'rendering' | 'loading' | 'ready' | 'cancelling' | 'failed';
  url?: string; width?: number; height?: number; error?: string;
};
type Request = {controller: AbortController; pending: boolean; url?: string};
const message = (error: unknown) => error instanceof Error ? error.message : 'The still could not be rendered. Try again.';

/** A capture owns its abort signal and object URL until dismissal. Cancellation
 * keeps the request occupied until the renderer actually releases its work. */
export function createViewportStillSession(
  onRender: ViewportStillProps['onRender'], onState: (state: StillState) => void,
) {
  let current: Request | undefined, disposed = false;
  let state: StillState = {phase: 'idle'};
  const emit = (next: StillState) => {state = next; if (!disposed) onState(next);};
  const valid = (request: Request) => !disposed && current === request && !request.controller.signal.aborted;
  const release = (request: Request) => {
    if (request.url) {URL.revokeObjectURL(request.url); request.url = undefined;}
  };
  const finishCancelled = (request: Request) => {
    release(request);
    if (current === request) {current = undefined; emit({phase: 'idle'});}
  };
  const cancel = () => {
    if (!current) {emit({phase: 'idle'}); return;}
    current.controller.abort(); release(current);
    if (current.pending) emit({phase: 'cancelling'});
    else finishCancelled(current);
  };
  const start = () => {
    if (disposed || current?.pending) return;
    if (current) {current.controller.abort(); release(current);}
    const request: Request = {controller: new AbortController(), pending: true};
    current = request; emit({phase: 'rendering'});
    // Call in the click turn: the parent captures this scene and camera.
    void (async () => {
      try {
        const capture = await onRender(request.controller.signal);
        request.pending = false;
        if (!valid(request)) {finishCancelled(request); return;}
        if (!capture.blob.size || ![capture.width, capture.height].every(value => Number.isSafeInteger(value) && value > 0))
          throw new Error('The viewport returned an empty still. Try again.');
        request.url = URL.createObjectURL(capture.blob);
        emit({phase: 'loading', url: request.url, width: capture.width, height: capture.height});
      } catch (error) {
        request.pending = false; release(request);
        if (!valid(request)) {finishCancelled(request); return;}
        emit({phase: 'failed', error: message(error)});
      }
    })();
  };
  return {
    start,
    retry: start,
    cancel,
    dismiss: cancel,
    imageReady(url: string, width: number, height: number) {
      if (current && valid(current) && state.phase === 'loading' && current.url === url && state.url === url) {
        if (width > 0 && height > 0) emit({...state, phase: 'ready', width, height});
        else {release(current); emit({phase: 'failed', error: 'The still could not be decoded. Try again.'});}
      }
    },
    imageFailed(url: string) {
      if (current && valid(current) && state.phase === 'loading' && current.url === url && state.url === url) {
        release(current); emit({phase: 'failed', error: 'The still could not be decoded. Try again.'});
      }
    },
    dispose() {disposed = true; cancel();},
  };
}

function StillSession({disabledReason, onRender, onPresent}: ViewportStillProps) {
  const [state, setState] = useState<StillState>({phase: 'idle'});
  const callbacks = useRef({onRender, onPresent}); callbacks.current = {onRender, onPresent};
  const session = useRef<ReturnType<typeof createViewportStillSession> | null>(null);
  const container = useRef<HTMLDivElement>(null), renderButton = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  useEffect(() => {
    const controller = createViewportStillSession(signal => callbacks.current.onRender(signal), setState);
    session.current = controller;
    return () => {controller.dispose(); session.current = null; callbacks.current.onPresent?.(false);};
  }, []);
  const showing = state.phase === 'ready';
  useEffect(() => {callbacks.current.onPresent?.(showing);}, [showing]);
  const dismiss = () => {
    if (container.current?.contains(document.activeElement)) renderButton.current?.focus({preventScroll: true});
    session.current?.dismiss();
  };
  const loading = state.phase === 'rendering' || state.phase === 'loading';
  const label = state.phase === 'loading' ? 'Loading still…' : state.phase === 'cancelling' ? 'Cancelling…' : 'Rendering still…';
  const actionLabel = showing ? 'Back to preview' : state.phase === 'idle' ? 'Render still' : state.phase === 'failed' ? 'Retry' : 'Cancel';
  const action = () => {
    if (state.phase === 'cancelling') return;
    if (state.phase === 'idle') session.current?.start();
    else if (state.phase === 'failed') session.current?.retry();
    else dismiss();
  };
  const imageLoaded = async (image: HTMLImageElement, url: string) => {
    const controller = session.current;
    try {
      if (image.decode) await image.decode();
      controller?.imageReady(url, image.naturalWidth, image.naturalHeight);
    } catch {controller?.imageFailed(url);}
  };
  return <div ref={container} className={`gesso-viewport-still${showing ? ' is-present' : ''}`}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && state.phase !== 'idle') {event.preventDefault(); dismiss();}
    }}>
    {state.url && <img className="gesso-viewport-still-image" src={state.url} alt="Rendered still of the current scene"
      decoding="async" draggable={false} aria-hidden={!showing}
      onLoad={event => void imageLoaded(event.currentTarget, state.url!)}
      onError={() => session.current?.imageFailed(state.url!)}/>}
    <div className="gesso-viewport-still-toolbar">
      <span className="gesso-viewport-still-label" role="status">{showing ? `Still · ${state.width} × ${state.height}` : 'Preview'}</span>
      {(loading || state.phase === 'cancelling') && <span className="gesso-feedback" data-tone="note" role="status">{label}</span>}
      <button ref={renderButton} key="action" type="button"
        disabled={(state.phase === 'idle' || state.phase === 'failed') && !!disabledReason}
        aria-disabled={state.phase === 'cancelling' || undefined}
        title={state.phase === 'idle' || state.phase === 'failed' ? disabledReason || 'Render the current view as a still' : undefined}
        aria-describedby={disabledReason && (state.phase === 'idle' || state.phase === 'failed') ? statusId : undefined}
        onClick={action}>{actionLabel}</button>
      {state.phase === 'failed' && <button type="button" onClick={dismiss}>Dismiss</button>}
    </div>
    {state.error && <p className="gesso-viewport-still-error" role="alert">{state.error}</p>}
    {disabledReason && (state.phase === 'idle' || state.phase === 'failed') && <span id={statusId} className="gesso-viewport-still-sr">{disabledReason}</span>}
  </div>;
}

export default function ViewportStill(props: ViewportStillProps) {
  const scope = useRef({value: props.scopeKey, generation: 0});
  // Survives a scope remount: an aborted renderer must finish releasing its
  // targets before a new scope can ask it for another capture.
  const pending = useRef<Promise<ViewportStillCapture> | null>(null);
  if (!Object.is(scope.current.value, props.scopeKey))
    scope.current = {value: props.scopeKey, generation: scope.current.generation + 1};
  const capture = (signal: AbortSignal) => {
    if (pending.current) return Promise.reject(new Error('The previous still is still being cancelled. Try again in a moment.'));
    const result = props.onRender(signal); pending.current = result;
    void result.then(() => {if (pending.current === result) pending.current = null;}, () => {if (pending.current === result) pending.current = null;});
    return result;
  };
  return <StillSession key={scope.current.generation} {...props} onRender={capture}/>;
}
