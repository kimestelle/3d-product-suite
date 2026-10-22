import {useEffect, useRef, type RefObject} from 'react';
import {LANDING_REEL_FPS, landingReelShotAt} from './landingReelMetadata';

function useReelMetadata(videoRef: RefObject<HTMLVideoElement | null>, visible: boolean, failed: boolean) {
  const clock = useRef<HTMLTimeElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !visible) return;
    const pad = (value: number) => String(value).padStart(2, '0');
    const paint = (time: number) => {
      const seconds = failed ? 0 : Math.max(0, time || 0);
      const frame = Math.floor(seconds * LANDING_REEL_FPS);
      const value = `${pad(Math.floor(seconds / 60))}:${pad(Math.floor(seconds) % 60)}:${pad(frame % LANDING_REEL_FPS)}`;
      const shot = landingReelShotAt(seconds);
      if (clock.current && clock.current.textContent !== value) clock.current.textContent = value;
      if (title.current && title.current.textContent !== shot.product) {
        title.current.textContent = shot.product;
        title.current.title = shot.credit;
      }
    };
    const update = () => paint(video.currentTime);
    const events = ['timeupdate', 'loadedmetadata', 'seeked', 'emptied', 'error'];
    events.forEach(event => video.addEventListener(event, update));
    update();
    // Follow presented frames without rerendering the page or its morphing shape.
    let callback: number | null = null;
    const next = (_: number, metadata: VideoFrameCallbackMetadata) => {
      paint(metadata.mediaTime);
      callback = video.requestVideoFrameCallback(next);
    };
    if (!failed && video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(next);
    return () => {
      events.forEach(event => video.removeEventListener(event, update));
      if (callback !== null) video.cancelVideoFrameCallback(callback);
    };
  }, [videoRef, visible, failed]);
  return {clock, title};
}

export default function LandingVideoOverlay({visible, playing, failed, videoRef, onToggle}: {
  visible: boolean; playing: boolean; failed: boolean;
  videoRef: RefObject<HTMLVideoElement | null>; onToggle: () => void;
}) {
  const {clock, title} = useReelMetadata(videoRef, visible, failed);
  const firstShot = landingReelShotAt(0);
  const playbackLabel = failed ? 'Retry video' : playing ? 'Pause video' : 'Play video';
  return <div className="landing-video-overlay" data-playing={playing} data-visible={visible} inert={!visible} aria-hidden={!visible}>
    <div className="landing-reel-topline">
      <button className="landing-recording" type="button" onClick={onToggle} aria-label={playbackLabel} title={playbackLabel}>
        <span className="landing-recording-dot" aria-hidden="true"/>
        <time ref={clock} className="landing-reel-clock" aria-label="Clip time">00:00:00</time>
      </button>
      <span ref={title} className="landing-reel-title" title={firstShot.credit}>{firstShot.product}</span>
    </div>
  </div>;
}
