import {LANDING_REEL_VERSION} from './landingReelMetadata';

export const LANDING_REEL_SRC = `/media/gesso-landing-reel.mp4?v=${LANDING_REEL_VERSION}`;
export const LANDING_REEL_MOBILE_SRC = `/media/gesso-landing-reel-mobile.mp4?v=${LANDING_REEL_VERSION}`;
export type LandingReelState = {frameReady: boolean; playing: boolean; wanted: boolean; failed: boolean};
export const LANDING_REEL_STILL: LandingReelState = {frameReady: false, playing: false, wanted: false, failed: false};

type Connection = EventTarget & {saveData?: boolean};

// One landing reel owns its media lifecycle. React owns the shape and poster;
// this controller only publishes whether an actual video frame can cover it.
export class LandingReel {
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private connection = (navigator as Navigator & {connection?: Connection}).connection;
  private manual: boolean | null = null;
  private entering: boolean;
  private disposed = false;
  private attached = false;
  private active = false;
  private playPending = false;
  private retryOnReady = false;
  private retriedOnReady = false;
  private epoch = 0;
  private pendingFrame: number | null = null;
  private frameReady = false;
  private playing = false;
  private failed = false;

  constructor(private video: HTMLVideoElement, private changed: (state: LandingReelState) => void, entering = false) {
    // Set both the reflected muted attribute and the live property before src
    // or play(). Inline autoplay on Safari must not depend on React's order.
    video.defaultMuted = true; video.muted = true; video.playsInline = true; video.autoplay = true;
    this.entering = entering;
    this.reduced.addEventListener('change', this.sync);
    this.connection?.addEventListener('change', this.sync);
    document.addEventListener('visibilitychange', this.resume);
    window.addEventListener('pageshow', this.resume);
    video.addEventListener('loadeddata', this.loaded);
    video.addEventListener('canplay', this.ready);
    video.addEventListener('playing', this.played);
    video.addEventListener('pause', this.paused);
    video.addEventListener('error', this.error);
    this.sync();
  }

  private get wanted() {
    return (this.manual ?? (!this.reduced.matches && !this.connection?.saveData))
      && !document.hidden && !this.entering && !this.failed && !this.disposed;
  }
  private publish = () => {
    if (!this.disposed) this.changed({frameReady: this.frameReady, playing: this.playing, wanted: this.wanted, failed: this.failed});
  };
  private cancelFrame() {
    if (this.pendingFrame !== null) this.video.cancelVideoFrameCallback(this.pendingFrame);
    this.pendingFrame = null;
  }
  private sync = () => {
    if (this.disposed) return;
    if (!this.wanted) {
      this.active = false; this.playPending = false; this.epoch++; this.cancelFrame(); this.video.pause(); this.playing = false;
    } else if (!this.active) {
      this.active = true;
      const epoch = ++this.epoch;
      if (!this.attached) {
        this.attached = true;
        this.video.preload = 'auto';
        // Choose before attaching src: a phone never fetches the desktop reel.
        this.video.src = matchMedia('(max-width: 760px)').matches ? LANDING_REEL_MOBILE_SRC : LANDING_REEL_SRC;
      }
      if (!this.frameReady) {
        if (this.video.requestVideoFrameCallback) {
          this.pendingFrame = this.video.requestVideoFrameCallback(() => {
            if (this.disposed || epoch !== this.epoch) return;
            this.pendingFrame = null; this.frameReady = true; this.publish();
          });
        } else if (this.video.readyState >= 2) this.frameReady = true;
      }
      // Play can reject after an intentional pause; the epoch makes it stale.
      this.playPending = true;
      const rejected = (error: unknown) => {
        if (epoch !== this.epoch || this.disposed) return;
        this.playPending = false;
        // Loading can interrupt Safari's first play request. Retry once after
        // enough data arrives; a policy rejection still needs the play button.
        this.retryOnReady = !this.retriedOnReady && error instanceof DOMException && error.name === 'AbortError';
        this.error();
        this.ready();
      };
      try {this.video.play().then(() => {if (epoch === this.epoch) this.playPending = false;}, rejected);}
      catch (error) {rejected(error);}
    }
    this.publish();
  };
  private loaded = () => {
    if (!this.video.requestVideoFrameCallback && this.video.readyState >= 2) {
      this.frameReady = true; this.publish();
    }
  };
  private ready = () => {
    if (!this.retryOnReady || this.video.readyState < 3 || this.disposed) return;
    this.retryOnReady = false; this.retriedOnReady = true; this.failed = false;
    this.sync();
  };
  private resume = () => {
    // A retained page can return from the back/forward cache with its video
    // paused even when its media controller was previously active.
    if (this.wanted && !this.playPending && (this.video.paused || !this.playing)) {
      this.cancelFrame(); this.active = false;
    }
    this.sync();
  };
  private played = () => {
    if (!this.wanted) {this.video.pause(); return;}
    this.playing = true; this.publish();
  };
  private paused = () => {this.playing = false; this.publish();};
  private error = () => {
    if (this.disposed) return;
    this.failed = true; this.frameReady = false; this.playing = false; this.sync();
  };

  toggle() {
    if (this.disposed) return;
    this.retryOnReady = false;
    if (this.wanted || this.playing) this.manual = false;
    else {
      this.manual = true; this.failed = false; this.retriedOnReady = false;
      // Media errors need a fresh load; autoplay rejection does not.
      if (this.video.error) this.video.load();
    }
    this.sync();
  }
  setEntering(entering: boolean) {
    this.entering = entering;
    this.sync();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.cancelFrame();
    this.reduced.removeEventListener('change', this.sync);
    this.connection?.removeEventListener('change', this.sync);
    document.removeEventListener('visibilitychange', this.resume);
    window.removeEventListener('pageshow', this.resume);
    this.video.removeEventListener('loadeddata', this.loaded);
    this.video.removeEventListener('canplay', this.ready);
    this.video.removeEventListener('playing', this.played);
    this.video.removeEventListener('pause', this.paused);
    this.video.removeEventListener('error', this.error);
    this.video.pause();
    if (this.attached) {this.video.removeAttribute('src'); this.video.load();}
  }
}
