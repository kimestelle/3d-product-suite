import type { ComparisonMode, Side, World } from './comparison';
import { compatibleWorlds, comparisonLabels, matchWorldRevision } from './comparison';

export type Point = [number, number, number];
export type CalibrationDraft = { floor?: Point; points: Point[]; distance: string; yaw: string };
export type PickRequest = { side: Side; kind: 'floor' | 'measurement' } | null;
export const emptyCalibration = (): CalibrationDraft => ({ points: [], distance: '', yaw: '' });

type Props = {
  scene: any; worlds: World[]; info: any; busy: boolean; ready: boolean;
  mode: ComparisonMode; drafts: Record<Side, CalibrationDraft>; picking: PickRequest;
  onMode: (mode: ComparisonMode) => void; onEnable: () => void; onDisable: () => void;
  onWorld: (side: Side, id: string) => void;
  onTransform: (side: Side, field: 'scaleToMeters' | 'translationM', value: number, axis?: number) => void;
  onDraft: (side: Side, patch: Partial<CalibrationDraft>) => void;
  onPick: (side: Side, kind: 'floor' | 'measurement') => void;
  onCancelPick: () => void; onCalibrate: (side: Side) => void; onReview: () => void;
};

function pointText(point?: Point) { return point ? point.map(value => value.toFixed(4)).join(', ') : 'No point selected'; }

export default function ComparisonPanel(props: Props) {
  const { scene, worlds, info, busy, ready, mode, drafts, picking } = props;
  if (!scene.comparison) return <section className="control-section comparison-intro">
    <div className="section-label"><span>COMPARE TWO ENVIRONMENTS</span></div>
    <p className="small-copy">Use one product, camera and timeline to compare World Labs’ official mesh with its Gaussian-derived mesh. Gallery and Botanical defaults work offline.</p>
    <button className="wide" disabled={busy} onClick={props.onEnable}>Enable A/B comparison</button>
  </section>;
  const labels = comparisonLabels(scene);
  const reviewed = ready && info?.alignmentStatus === 'reviewed';
  const environments = { a: scene.environment, b: scene.comparison.alternative };
  const meshes = worlds.filter(world => world.environment.kind === 'mesh');
  return <section className="control-section comparison-controls">
    <div className="comparison-heading"><b>Environment comparison</b><span className={`comparison-status ${reviewed ? 'reviewed' : ''}`}>{reviewed ? 'Placement reviewed' : 'Draft placement'}</span></div>
    <p className="small-copy">Both views share the product, plinth, lighting, camera and frame. Placement review records your visual check; it does not certify geometry or material accuracy.</p>
    <div className="segmented comparison-modes" aria-label="Comparison view">
      {(['a', 'b', 'split'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => props.onMode(value)}>{value === 'split' ? 'Split view' : `View ${value.toUpperCase()}`}</button>)}
    </div>
    <p className="pairing-note">{info?.pairing?.sameWorld ? 'Same World Labs world · two mesh methods' : 'Two selected environments · shared product and cameras'}</p>
    {(['a', 'b'] as const).map(side => {
      const environment = environments[side]; const other = environments[side === 'a' ? 'b' : 'a'];
      const asset = environment.asset; const draft = drafts[side];
      const selected = matchWorldRevision(meshes, environment);
      return <div key={side} className="comparison-side-controls">
        <h3><span>{side.toUpperCase()}</span>{labels[side]}</h3>
        <label className="field"><span>Environment {side.toUpperCase()}</span><select aria-label={`Environment ${side.toUpperCase()}`} value={selected?.id ?? ''} disabled={busy} onChange={event => props.onWorld(side, event.target.value)}>
          {!selected && <option value="">Current saved environment</option>}
          {meshes.map(world => <option key={world.id} value={world.id} disabled={!compatibleWorlds(world.environment, other)}>{world.name}</option>)}
        </select></label>
        <label className="field"><span>Meters per source unit · {side.toUpperCase()}</span><input aria-label={`Scale ${side.toUpperCase()}`} type="number" min={0.00001} step={.01} value={asset.scaleToMeters} disabled={busy} onChange={event => { const value = Number(event.target.value); if (event.target.value && Number.isFinite(value) && value > 0) props.onTransform(side, 'scaleToMeters', value); }}/></label>
        <div className="three-col">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label className="field" key={axis}><span>{axis} (m) · {side.toUpperCase()}</span><input aria-label={`${axis} translation ${side.toUpperCase()}`} type="number" step={.01} value={Number(asset.translationM[index].toFixed(5))} disabled={busy} onChange={event => { const value = Number(event.target.value); if (event.target.value && Number.isFinite(value)) props.onTransform(side, 'translationM', value, index); }}/></label>)}</div>
        <details className="calibration-form"><summary>Floor and known distance · {side.toUpperCase()}</summary>
          <p className="small-copy">Pick the floor near the product. Optionally pick two points with a known real distance to set scale. Picks refer to this environment only.</p>
          <button className="wide" disabled={busy || !ready} aria-pressed={picking?.side === side && picking.kind === 'floor'} onClick={() => props.onPick(side, 'floor')}>Pick floor · {side.toUpperCase()}</button>
          <p className="picked-point">Floor: {pointText(draft.floor)}</p>
          <button className="wide" disabled={busy || !ready} aria-pressed={picking?.side === side && picking.kind === 'measurement'} onClick={() => props.onPick(side, 'measurement')}>Pick two measurement points · {side.toUpperCase()}</button>
          <p className="picked-point">{draft.points.length}/2 points selected{draft.points.length > 0 && <> · {draft.points.map(pointText).join(' / ')}</>}</p>
          <label className="field"><span>Known distance (m) · {side.toUpperCase()}</span><input aria-label={`Known distance ${side.toUpperCase()}`} type="number" min={.00001} step={.01} value={draft.distance} onChange={event => props.onDraft(side, { distance: event.target.value })}/></label>
          <label className="field"><span>Additional yaw (degrees) · {side.toUpperCase()}</span><input aria-label={`Yaw ${side.toUpperCase()}`} type="number" step={1} value={draft.yaw} onChange={event => props.onDraft(side, { yaw: event.target.value })}/></label>
          <button className="wide" disabled={busy || !ready || (!draft.floor && draft.points.length !== 2 && !Number(draft.yaw))} onClick={() => props.onCalibrate(side)}>Apply placement · {side.toUpperCase()}</button>
        </details>
      </div>;
    })}
    {picking && <div className="message notice" role="status">Click {picking.kind === 'floor' ? 'the floor' : `${2 - drafts[picking.side].points.length} measurement point(s)`} in view {picking.side.toUpperCase()}.<button className="text-button" onClick={props.onCancelPick}>Cancel picking</button></div>}
    <button className="wide" disabled={busy || !ready || reviewed} onClick={props.onReview}>{reviewed ? 'Placement review saved in this scene' : 'Mark placement reviewed'}</button>
    <p className="small-copy">Save a revision to keep the pair and placement. Changing either environment transform makes placement draft again. Draft exports remain available.</p>
    <button className="text-button" disabled={busy} onClick={props.onDisable}>Exit comparison · keep environment A</button>
  </section>;
}

export function ComparisonJobList({ jobs, digest, busy, onControl }: {
  jobs: any[]; digest: string; busy: boolean; onControl: (id: string, action: 'cancel' | 'resume') => void;
}) {
  return <>{jobs.map(job => <article className="job comparison-job" key={job.id}>
    <div className="job-heading"><b>Matching {job.kind === 'still' ? 'stills' : 'reels'} · A/B</b><span className={`job-state ${job.state}`}>{job.state}</span></div>
    <span className={`comparison-status ${job.alignmentStatus === 'reviewed' ? 'reviewed' : ''}`}>{job.alignmentStatus === 'reviewed' ? 'Placement reviewed' : 'Draft placement'}</span>
    {job.frame && <p>Frame {job.frame} · identical camera and product</p>}
    {job.sourceDigest !== digest && <p className="stale">Earlier scene revision</p>}
    {job.error && <p className="job-error">{job.error}</p>}
    <div className="job-links">{(job.artifacts ?? []).map((artifact: any) => <a key={artifact.name} href={artifact.url} target="_blank" rel="noreferrer">{artifact.name} ↗</a>)}</div>
    {(['a', 'b'] as const).map(side => {
      const child = job.children?.[side];
      return <div className="comparison-child" key={side}><b>Environment {side.toUpperCase()} · {child?.state ?? 'Preparing'}</b>{child && <p>{child.completedFrames}/{child.totalFrames} frames</p>}
        {child?.error && <p className="job-error">{child.error}</p>}
        <div className="job-links">{(child?.artifacts ?? []).map((artifact: any) => <a key={artifact.name} href={artifact.url} target="_blank" rel="noreferrer">{side.toUpperCase()} · {artifact.name} ↗</a>)}</div>
      </div>;
    })}
    {(['queued', 'running'].includes(job.state) || Object.values(job.children ?? {}).some((child: any) => ['queued', 'running'].includes(child?.state))) && <button disabled={busy} onClick={() => onControl(job.id, 'cancel')}>Cancel both</button>}
    {['failed', 'cancelled', 'interrupted'].includes(job.state) && <button disabled={busy} onClick={() => onControl(job.id, 'resume')}>Resume pair</button>}
  </article>)}</>;
}
