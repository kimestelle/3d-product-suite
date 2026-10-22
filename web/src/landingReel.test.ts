import {afterEach, describe, expect, it, vi} from 'vitest';
import {LANDING_REEL_SRC, LANDING_REEL_MOBILE_SRC, LANDING_REEL_STILL, LandingReel, type LandingReelState} from './landingReel';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
const flush = async () => {await Promise.resolve(); await Promise.resolve();};
const disposals: (() => void)[] = [];

function setup({reduced = false, saveData = false, hidden = false, entering = false, frameCallback = true, compact = false} = {}) {
  const preference = Object.assign(new EventTarget(), {matches: reduced});
  const mobile = Object.assign(new EventTarget(), {matches: compact});
  const connection = Object.assign(new EventTarget(), {saveData});
  const page = Object.assign(new EventTarget(), {hidden});
  const window = new EventTarget();
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query.includes('max-width') ? mobile : preference));
  vi.stubGlobal('navigator', {connection});
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', window);
  const attempts: ReturnType<typeof deferred>[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const video = Object.assign(new EventTarget(), {
    src: '', preload: 'none', readyState: 0, error: null as MediaError | null, muted: false, defaultMuted: false, playsInline: false, autoplay: false, paused: false,
    play: vi.fn(() => {const attempt = deferred(); attempts.push(attempt); return attempt.promise;}),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((name: string) => {if (name === 'src') video.src = '';}),
    requestVideoFrameCallback: frameCallback ? vi.fn((callback: () => void) => {frames.set(++nextFrame, callback); return nextFrame;}) : undefined,
    cancelVideoFrameCallback: vi.fn((id: number) => {frames.delete(id);}),
  });
  const sources: {src: string; muted: boolean; defaultMuted: boolean; playsInline: boolean; autoplay: boolean}[] = [];
  let currentSource = '';
  Object.defineProperty(video, 'src', {get: () => currentSource, set: (src: string) => {
    currentSource = src;
    sources.push({src, muted: video.muted, defaultMuted: video.defaultMuted, playsInline: video.playsInline, autoplay: video.autoplay});
  }});
  let state: LandingReelState = {...LANDING_REEL_STILL};
  const changed = vi.fn((next: LandingReelState) => {state = next;});
  const reel = new LandingReel(video as unknown as HTMLVideoElement, changed, entering);
  disposals.push(() => reel.dispose());
  return {reel, video, preference, connection, page, window, attempts, frames, sources, changed, state: () => state,
    present: () => {const [id, callback] = frames.entries().next().value!; frames.delete(id); callback();},
  };
}

afterEach(() => {disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('landing reel playback', () => {
  it('selects only the small phone reel and establishes inline muted autoplay before its request', () => {
    const {video, sources} = setup({compact: true});
    expect(video.src).toBe(LANDING_REEL_MOBILE_SRC);
    expect(sources).toEqual([{src: LANDING_REEL_MOBILE_SRC, muted: true, defaultMuted: true, playsInline: true, autoplay: true}]);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('waits to select the phone source until its page becomes active', () => {
    const {reel, video, sources} = setup({compact: true, entering: true});
    expect(sources).toEqual([]);
    reel.setEntering(false);
    expect(video.src).toBe(LANDING_REEL_MOBILE_SRC);
    expect(sources.map(source => source.src)).toEqual([LANDING_REEL_MOBILE_SRC]);
  });

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
    expect(video).toMatchObject({muted: true, defaultMuted: true, playsInline: true, autoplay: true});
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

  it('retries an interrupted initial play once when the media becomes ready', async () => {
    const {video, attempts, state} = setup({compact: true});
    attempts[0].reject(new DOMException('Load interrupted', 'AbortError')); await flush();
    expect(state().failed).toBe(true);
    video.readyState = 3;
    video.dispatchEvent(new Event('canplay'));
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({failed: false, wanted: true});
    attempts[1].reject(new DOMException('Still interrupted', 'AbortError')); await flush();
    video.dispatchEvent(new Event('canplay'));
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(state().failed).toBe(true);
  });

  it('does not retry a policy-blocked autoplay when ready events repeat', async () => {
    const {video, attempts, state} = setup({compact: true});
    attempts[0].reject(new DOMException('Needs a gesture', 'NotAllowedError')); await flush();
    video.readyState = 4;
    video.dispatchEvent(new Event('canplay')); video.dispatchEvent(new Event('canplay'));
    expect(video.play).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({failed: true, wanted: false});
  });

  it('resumes a browser-paused retained page on pageshow without duplicating pending play', async () => {
    const {video, attempts, window} = setup({compact: true});
    window.dispatchEvent(new Event('pageshow'));
    expect(video.play).toHaveBeenCalledOnce();
    video.dispatchEvent(new Event('playing'));
    attempts[0].resolve(); await flush();
    video.paused = true;
    window.dispatchEvent(new Event('pageshow'));
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('replaces an unpresented frame callback on restore and cancels its replacement on disposal', async () => {
    const {reel, video, attempts, window, frames, changed} = setup({compact: true});
    const staleFrame = [...frames.values()][0];
    attempts[0].resolve(); await flush();
    video.paused = true;
    window.dispatchEvent(new Event('pageshow'));
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect([...frames.keys()]).toEqual([2]);
    reel.dispose();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(2);
    expect(frames.size).toBe(0);
    const updates = changed.mock.calls.length;
    staleFrame();
    expect(changed).toHaveBeenCalledTimes(updates);
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
    const {reel, video, page, window, state, present} = setup();
    present(); reel.toggle();
    expect(state()).toMatchObject({wanted: false, frameReady: true});
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    reel.setEntering(true); reel.setEntering(false);
    window.dispatchEvent(new Event('pageshow'));
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
    const {reel, video, preference, connection, page, window, attempts, changed, frames} = setup();
    const staleFrame = [...frames.values()][0];
    reel.dispose(); reel.dispose();
    const updates = changed.mock.calls.length;
    staleFrame(); attempts[0].reject(new DOMException('Removed', 'AbortError')); await flush();
    preference.dispatchEvent(new Event('change')); connection.dispatchEvent(new Event('change'));
    page.dispatchEvent(new Event('visibilitychange')); video.dispatchEvent(new Event('playing'));
    window.dispatchEvent(new Event('pageshow')); video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('error')); video.dispatchEvent(new Event('loadeddata'));
    expect(changed).toHaveBeenCalledTimes(updates);
    expect(video.play).toHaveBeenCalledOnce(); expect(video.pause).toHaveBeenCalled();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(video.src).toBe(''); expect(video.load).toHaveBeenCalledOnce();
  });
});
