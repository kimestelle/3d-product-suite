import {useEffect, useState, type RefObject} from 'react';
function ReelClock({videoRef, visible}: {videoRef: RefObject<HTMLVideoElement | null>; visible: boolean}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !visible) return;
    const update = () => setFrame(Math.floor(Math.max(0, video.currentTime || 0) * 24));
    const events = ['timeupdate', 'loadedmetadata', 'seeked', 'emptied'];
    events.forEach(event => video.addEventListener(event, update));
    update();
    return () => events.forEach(event => video.removeEventListener(event, update));
  }, [videoRef, visible]);
  const pad = (value: number) => String(value).padStart(2, '0');
  return <time className="landing-reel-clock" aria-label="Clip time">{pad(Math.floor(frame / 1440))}:{pad(Math.floor(frame / 24) % 60)}:{pad(frame % 24)}</time>;
}

export default function LandingVideoOverlay({visible, playing, failed, videoRef, onToggle}: {
  visible: boolean; playing: boolean; failed: boolean;
  videoRef: RefObject<HTMLVideoElement | null>; onToggle: () => void;
}) {
  const playbackLabel = failed ? 'Retry video' : playing ? 'Pause video' : 'Play video';
  return <div className="landing-video-overlay" data-playing={playing} data-visible={visible} inert={!visible} aria-hidden={!visible}>
    <div className="landing-reel-topline">
      <button className="landing-recording" type="button" onClick={onToggle} aria-label={playbackLabel} title={playbackLabel}>
        <span className="landing-recording-dot" aria-hidden="true"/>
        <ReelClock videoRef={videoRef} visible={visible}/>
      </button>
      <span className="landing-reel-title">Nessino lamp</span>
    </div>
  </div>;
}
