import './viewport-loading.css';

/** CSS owns the pulse; no extra render loop or changes to the canvas buffer. */
export default function ViewportLoading({loading}: {loading: boolean}) {
  return <div className="gesso-viewport-loading" data-loading={loading} aria-hidden={!loading}>
    <div className="gesso-viewport-loading-veil"/>
    <span className="gesso-viewport-loading-label" role="status" aria-live="polite" aria-label="Loading scene">
      <span aria-hidden="true">loading<span className="gesso-viewport-loading-dots"><span>.</span><span>.</span><span>.</span></span></span>
    </span>
  </div>;
}
