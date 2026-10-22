import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import ViewportStill, {createViewportStillSession, type ViewportStillCapture} from './ViewportStillOverlay';

const captured: ViewportStillCapture = {blob: new Blob(['png pixels'], {type: 'image/png'}), width: 1920, height: 1080};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const flush = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};
function setup() {
  const onRender = vi.fn<(signal: AbortSignal) => Promise<ViewportStillCapture>>().mockResolvedValue(captured);
  const onState = vi.fn();
  const session = createViewportStillSession(onRender, onState);
  return {onRender, onState, session};
}
beforeEach(() => {
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:still-${++next}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('viewport still capture lifetime', () => {
  it('only starts on request, invokes capture in the click turn, and prevents overlap', async () => {
    const fixture = setup(), pending = deferred<ViewportStillCapture>(); fixture.onRender.mockReturnValueOnce(pending.promise);
    expect(fixture.onRender).not.toHaveBeenCalled();
    fixture.session.start();
    expect(fixture.onRender).toHaveBeenCalledTimes(1);
    fixture.session.start(); fixture.session.retry();
    expect(fixture.onRender).toHaveBeenCalledTimes(1);
    expect(fixture.onRender.mock.calls[0][0].aborted).toBe(false);
    pending.resolve(captured); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading', url: 'blob:still-1'}));
    fixture.session.dispose();
  });
  it('keeps cancellation busy until the capture settles and never allocates a stale blob URL', async () => {
    const fixture = setup(), pending = deferred<ViewportStillCapture>(); fixture.onRender.mockReturnValueOnce(pending.promise);
    fixture.session.start(); fixture.session.cancel();
    expect(fixture.onRender.mock.calls[0][0].aborted).toBe(true);
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'cancelling'});
    fixture.session.start(); fixture.session.retry();
    expect(fixture.onRender).toHaveBeenCalledTimes(1);
    pending.resolve(captured); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'idle'});
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fixture.session.start(); await flush(); expect(fixture.onRender).toHaveBeenCalledTimes(2);
    fixture.session.dispose();
  });
  it('returns to preview after an abort rejection without reporting a capture failure', async () => {
    const fixture = setup(), pending = deferred<ViewportStillCapture>(); fixture.onRender.mockReturnValueOnce(pending.promise);
    fixture.session.start(); fixture.session.cancel(); pending.reject(new DOMException('Aborted', 'AbortError')); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'idle'});
    expect(fixture.onState.mock.calls.some(([state]) => state.phase === 'failed')).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('aborts on unmount and ignores late success without state updates or URL allocations', async () => {
    const fixture = setup(), pending = deferred<ViewportStillCapture>(); fixture.onRender.mockReturnValueOnce(pending.promise);
    fixture.session.start(); fixture.session.dispose(); fixture.onState.mockClear();
    expect(fixture.onRender.mock.calls[0][0].aborted).toBe(true);
    pending.resolve(captured); await flush();
    expect(fixture.onState).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('requires decode acknowledgement before presenting and revokes the URL on Back to preview', async () => {
    const fixture = setup(); fixture.session.start(); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading'}));
    fixture.session.imageReady('blob:wrong', 1920, 1080);
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading'}));
    fixture.session.imageReady('blob:still-1', 1920, 1080);
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'ready', width: 1920, height: 1080}));
    fixture.session.dismiss();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:still-1');
    fixture.session.imageReady('blob:still-1', 1920, 1080);
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'idle'});
    fixture.session.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('revokes an undecoded URL on cancel and never accepts its late decode', async () => {
    const fixture = setup(); fixture.session.start(); await flush(); fixture.session.cancel();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:still-1');
    fixture.session.imageReady('blob:still-1', 1920, 1080);
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'idle'});
  });
  it('revokes the completed image when its scope unmounts', async () => {
    const fixture = setup(); fixture.session.start(); await flush(); fixture.session.imageReady('blob:still-1', 1920, 1080);
    fixture.session.dispose(); fixture.onState.mockClear(); fixture.session.imageFailed('blob:still-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:still-1');
    expect(fixture.onState).not.toHaveBeenCalled();
  });
  it('revokes a failed decode before retrying with a fresh image', async () => {
    const fixture = setup(); fixture.session.start(); await flush(); fixture.session.imageFailed('blob:still-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:still-1');
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'failed', error: expect.stringContaining('decoded')}));
    fixture.session.retry(); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading', url: 'blob:still-2'}));
    fixture.session.imageReady('blob:still-1', 1920, 1080);
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading', url: 'blob:still-2'}));
    fixture.session.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('treats zero decoded dimensions as a failure and releases the image', async () => {
    const fixture = setup(); fixture.session.start(); await flush(); fixture.session.imageReady('blob:still-1', 0, 0);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:still-1');
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'failed'}));
  });
  it('surfaces capture failures and retries without keeping an old URL', async () => {
    const fixture = setup(); fixture.onRender.mockRejectedValueOnce(new Error('Viewport is busy'));
    fixture.session.start(); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'failed', error: 'Viewport is busy'});
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fixture.session.retry(); await flush();
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'loading'}));
    fixture.session.dispose();
  });
  it('handles synchronous renderer failures without leaving the action busy', async () => {
    const fixture = setup(); fixture.onRender.mockImplementationOnce(() => {throw new Error('Context unavailable');});
    fixture.session.start(); expect(fixture.onState).toHaveBeenLastCalledWith({phase: 'failed', error: 'Context unavailable'});
    fixture.session.retry(); await flush(); expect(fixture.onRender).toHaveBeenCalledTimes(2); fixture.session.dispose();
  });
  it('rejects empty capture output without allocating a URL', async () => {
    const fixture = setup(); fixture.onRender.mockResolvedValueOnce({...captured, blob: new Blob([])});
    fixture.session.start(); await flush(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(fixture.onState).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'failed'}));
  });
});

describe('viewport still controls', () => {
  it('uses native controls and no image, canvas, export job, or download until requested', () => {
    const fixture = setup();
    const html = renderToStaticMarkup(<ViewportStill scopeKey={{revision: 1}} disabledReason="The viewport is loading" onRender={fixture.onRender}/>);
    expect(html).toContain('Preview'); expect(html).toContain('Render still');
    expect(html).toContain('The viewport is loading'); expect(html).toContain('disabled=""');
    expect(html).not.toContain('<canvas'); expect(html).not.toContain('<img'); expect(html).not.toContain('Download');
    expect(fixture.onRender).not.toHaveBeenCalled();
  });
});
