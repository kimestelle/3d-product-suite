import {afterEach, describe, expect, it, vi} from 'vitest';
import {LANDING_REEL_SRC, LANDING_REEL_STILL, LandingReel, type LandingReelState} from './landingReel';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
const flush = async () => {await Promise.resolve(); await Promise.resolve();};
const disposals: (() => void)[] = [];

function setup({reduced = false, saveData = false, hidden = false, entering = false, frameCallback = true} = {}) {
  const preference = Object.assign(new EventTarget(), {matches: reduced});
  const connection = Object.assign(new EventTarget(), {saveData});
  const page = Object.assign(new EventTarget(), {hidden});
  vi.stubGlobal('matchMedia', vi.fn(() => preference));
  vi.stubGlobal('navigator', {connection});
  vi.stubGlobal('document', page);
  const attempts: ReturnType<typeof deferred>[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const video = Object.assign(new EventTarget(), {
    src: '', preload: 'none', readyState: 0, error: null as MediaError | null, muted: false, defaultMuted: false, playsInline: false,
    play: vi.fn(() => {const attempt = deferred(); attempts.push(attempt); return attempt.promise;}),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((name: string) => {if (name === 'src') video.src = '';}),
    requestVideoFrameCallback: frameCallback ? vi.fn((callback: () => void) => {frames.set(++nextFrame, callback); return nextFrame;}) : undefined,
    cancelVideoFrameCallback: vi.fn((id: number) => {frames.delete(id);}),
  });
  let state: LandingReelState = {...LANDING_REEL_STILL};
  const changed = vi.fn((next: LandingReelState) => {state = next;});
  const reel = new LandingReel(video as unknown as HTMLVideoElement, changed, entering);
  disposals.push(() => reel.dispose());
  return {reel, video, preference, connection, page, attempts, frames, changed, state: () => state,
    present: () => {const [id, callback] = frames.entries().next().value!; frames.delete(id); callback();},
  };
}

afterEach(() => {disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('landing reel playback', () => {
  it.each([{reduced: true}, {saveData: true}])('does not fetch with %o until explicit play', (preference) => {
    const {reel, video, state} = setup(preference);
    expect(video.src).toBe(''); expect(video.preload).toBe('none'); expect(video.play).not.toHaveBeenCalled();
    expect(state()).toMatchObject({wanted: false, frameReady: false});
    reel.toggle();
    expect(video.src).toBe(LANDING_REEL_SRC); expect(video.preload).toBe('auto'); expect(video.play).toHaveBeenCalledOnce();
    expect(state().wanted).toBe(true);
  });

  it.each([{hidden: true}, {entering: true}])('does not fetch while initially %o', (context) => {
    const {reel, video, page} = setup(context);
    expect(video.src).toBe(''); expect(video.play).not.toHaveBeenCalled();
    if (context.hidden) {page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));}
    else reel.setEntering(false);
    expect(video.src).toBe(LANDING_REEL_SRC); expect(video.play).toHaveBeenCalledOnce();
  });

  it('keeps the poster through metadata, loadeddata, and playing until a presented frame', async () => {
    const {video, attempts, state, present} = setup();
    expect(video.src).toBe(LANDING_REEL_SRC);
    expect(video).toMatchObject({muted: true, defaultMuted: true, playsInline: true});
    video.readyState = 2;
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('playing'));
    attempts[0].resolve(); await flush();
    expect(state()).toMatchObject({playing: true, frameReady: false});
    present();
    expect(state().frameReady).toBe(true);
  });

  it('uses decoded loadeddata when frame callbacks are unavailable', () => {
    const {video, state} = setup({frameCallback: false});
    video.dispatchEvent(new Event('loadeddata'));
    expect(state().frameReady).toBe(false);
    video.readyState = 2; video.dispatchEvent(new Event('loadeddata'));
    expect(state().frameReady).toBe(true);
  });

  it('handles rejected autoplay with the poster and allows a manual retry', async () => {
    const {reel, video, attempts, state, frames, present} = setup();
    attempts[0].reject(new DOMException('Blocked', 'NotAllowedError')); await flush();
    expect(state()).toMatchObject({failed: true, wanted: false, playing: false, frameReady: false});
    expect(frames.size).toBe(0);
    reel.toggle();
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({failed: false, wanted: true, frameReady: false});
    present(); expect(state().frameReady).toBe(true);
  });

  it.each(['hidden', 'entering'] as const)('pauses for %s and ignores the pending play rejection and cancelled frame', async (reason) => {
    const {reel, video, page, attempts, frames, state} = setup();
    const staleFrame = [...frames.values()][0];
    if (reason === 'hidden') {page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));}
    else reel.setEntering(true);
    expect(video.pause).toHaveBeenCalled(); expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(state().wanted).toBe(false);
    staleFrame(); attempts[0].reject(new DOMException('Paused', 'AbortError')); await flush();
    expect(state()).toMatchObject({failed: false, frameReady: false, wanted: false});
    if (reason === 'hidden') {page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));}
    else reel.setEntering(false);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('preserves user pause across visibility and entry changes', () => {
    const {reel, video, page, state, present} = setup();
    present(); reel.toggle();
    expect(state()).toMatchObject({wanted: false, frameReady: true});
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    reel.setEntering(true); reel.setEntering(false);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('responds to changed preferences and retains explicit play consent', () => {
    const {reel, video, preference, connection, state} = setup();
    preference.matches = true; preference.dispatchEvent(new Event('change'));
    expect(state().wanted).toBe(false);
    reel.toggle();
    connection.saveData = true; connection.dispatchEvent(new Event('change'));
    expect(state().wanted).toBe(true); expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('returns to the poster on a media error and reloads only when retrying', () => {
    const {reel, video, present, state} = setup();
    present();
    video.error = {code: 3} as MediaError;
    video.dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({failed: true, frameReady: false, wanted: false});
    expect(video.load).not.toHaveBeenCalled();
    reel.toggle(); expect(video.load).toHaveBeenCalledOnce(); expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('cancels callbacks, pauses, releases the source, and removes listeners on disposal', async () => {
    const {reel, video, preference, connection, page, attempts, changed, frames} = setup();
    const staleFrame = [...frames.values()][0];
    reel.dispose(); reel.dispose();
    const updates = changed.mock.calls.length;
    staleFrame(); attempts[0].reject(new DOMException('Removed', 'AbortError')); await flush();
    preference.dispatchEvent(new Event('change')); connection.dispatchEvent(new Event('change'));
    page.dispatchEvent(new Event('visibilitychange')); video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('error')); video.dispatchEvent(new Event('loadeddata'));
    expect(changed).toHaveBeenCalledTimes(updates);
    expect(video.play).toHaveBeenCalledOnce(); expect(video.pause).toHaveBeenCalled();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(video.src).toBe(''); expect(video.load).toHaveBeenCalledOnce();
  });
});
