import {LANDING_REEL_VERSION} from './landingReelMetadata';

export const LANDING_REEL_SRC = `/media/gesso-landing-reel.mp4?v=${LANDING_REEL_VERSION}`;
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
  private epoch = 0;
  private pendingFrame: number | null = null;
  private frameReady = false;
  private playing = false;
  private failed = false;

  constructor(private video: HTMLVideoElement, private changed: (state: LandingReelState) => void, entering = false) {
    // Set both the reflected muted attribute and the live property before src
    // or play(). Inline autoplay on Safari must not depend on React's order.
    video.defaultMuted = true; video.muted = true; video.playsInline = true;
    this.entering = entering;
    this.reduced.addEventListener('change', this.sync);
    this.connection?.addEventListener('change', this.sync);
    document.addEventListener('visibilitychange', this.sync);
    video.addEventListener('loadeddata', this.loaded);
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
      this.active = false; this.epoch++; this.cancelFrame(); this.video.pause(); this.playing = false;
    } else if (!this.active) {
      this.active = true;
      const epoch = ++this.epoch;
      if (!this.attached) {
        this.attached = true;
        this.video.preload = 'auto';
        this.video.src = LANDING_REEL_SRC;
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
      try {this.video.play().catch(() => {if (epoch === this.epoch) this.error();});}
      catch {if (epoch === this.epoch) this.error();}
    }
    this.publish();
  };
  private loaded = () => {
    if (!this.video.requestVideoFrameCallback && this.video.readyState >= 2) {
      this.frameReady = true; this.publish();
    }
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
    if (this.wanted || this.playing) this.manual = false;
    else {
      this.manual = true; this.failed = false;
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
    document.removeEventListener('visibilitychange', this.sync);
    this.video.removeEventListener('loadeddata', this.loaded);
    this.video.removeEventListener('playing', this.played);
    this.video.removeEventListener('pause', this.paused);
    this.video.removeEventListener('error', this.error);
    this.video.pause();
    if (this.attached) {this.video.removeAttribute('src'); this.video.load();}
  }
}
