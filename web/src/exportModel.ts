export type ExportMode = 'still' | 'video';
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'mp4' | 'prores' | 'png-sequence';
export type ExportScale = .5 | 1 | 2;
export type ExportScene = {render: {width: number; height: number; fps: number; samples: number; durationFrames?: number}; shots?: {endFrame: number}[]; comparison?: unknown};
export type ExportCapabilities = {blenderAvailable?: boolean; ffmpegAvailable?: boolean; blenderIssue?: string; ffmpegIssue?: string};
export type ExportPayload = {kind: 'still' | 'reel'; format: ExportFormat; filename: string; frame: number; width: number; height: number; samples: number};
export type ExportArtifact = {name: string; url: string; downloadName?: string; bytes?: number};
export type ExportJob = {
  id: string; kind: 'still' | 'reel'; state: string; format?: ExportFormat; filename?: string;
  frame?: number; fps?: number; samples?: number; width?: number; height?: number;
  completedFrames: number; totalFrames: number; sourceDigest?: string; error?: string | null;
  stage?: string; artifacts: ExportArtifact[]; createdAt?: string; paired?: boolean; primaryArtifact?: string; canCancel?: boolean;
};
export const exportFormats: Record<ExportFormat, {mode: ExportMode; label: string; detail: string; extension: string; artifact: string; needsEncoder: boolean}> = {
  png: {mode: 'still', label: 'PNG', detail: 'Lossless image · design handoff', extension: '.png', artifact: 'still.png', needsEncoder: false},
  jpeg: {mode: 'still', label: 'JPEG', detail: 'Smaller image · catalogs + sharing', extension: '.jpg', artifact: 'still.jpg', needsEncoder: true},
  webp: {mode: 'still', label: 'WebP', detail: 'Compact image · websites', extension: '.webp', artifact: 'still.webp', needsEncoder: true},
  mp4: {mode: 'video', label: 'MP4 / H.264', detail: 'Web + social video', extension: '.mp4', artifact: 'film.mp4', needsEncoder: true},
  prores: {mode: 'video', label: 'MOV / ProRes 422', detail: 'Video editing handoff · larger file', extension: '.mov', artifact: 'film.mov', needsEncoder: true},
  'png-sequence': {mode: 'video', label: 'PNG sequence', detail: 'Every frame · ZIP for compositing', extension: '.zip', artifact: 'frames.zip', needsEncoder: false},
};
export function formatsForMode(mode: ExportMode, paired = false): ExportFormat[] {
  return (Object.keys(exportFormats) as ExportFormat[]).filter(format => exportFormats[format].mode === mode && (!paired || format === 'png' || format === 'mp4'));
}
/** Matches the server's filename stem rules. Names are never filesystem paths. */
export function exportFilename(value: string): string {
  return value.trim().replace(/\.(?:png|jpe?g|webp|mp4|mov|zip|blend)$/i, '').replace(/[^a-zA-Z0-9 _.-]+/g, '-').replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 80).replace(/[ .-]+$/g, '') || 'gesso';
}
export function exportDimensions(scene: ExportScene, scale: ExportScale): {width: number; height: number} {
  if (![.5, 1, 2].includes(scale)) throw new Error('Choose 0.5×, 1×, or 2× resolution.');
  const width = scene.render.width * scale, height = scene.render.height * scale;
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 16384 && value % 2 === 0)) throw new Error('This scale needs even dimensions between 2 and 16,384 px. Choose another scale.');
  return {width, height};
}
export function totalExportFrames(scene: ExportScene): number {return scene.render.durationFrames ?? Math.max(1, ...(scene.shots ?? []).map(shot => shot.endFrame));}
export function exportBlockReason(capabilities: ExportCapabilities, format: ExportFormat, blockedReason?: string): string {
  if (blockedReason) return blockedReason;
  if (capabilities.blenderAvailable !== true) return capabilities.blenderIssue || (capabilities.blenderAvailable === undefined ? 'Checking the local renderer…' : 'Blender 4.3.2 is required to render.');
  if (exportFormats[format].needsEncoder && capabilities.ffmpegAvailable !== true) return capabilities.ffmpegIssue || (capabilities.ffmpegAvailable === undefined ? 'Checking the local encoder…' : 'FFmpeg 7.1.5 is required for this format.');
  return '';
}
export function makeExportPayload(scene: ExportScene, settings: {mode: ExportMode; format: ExportFormat; filename: string; frame: number; scale: ExportScale; samples: number}): ExportPayload {
  if (!formatsForMode(settings.mode, !!scene.comparison).includes(settings.format)) throw new Error('Choose a format available for this export.');
  const dimensions = exportDimensions(scene, settings.scale);
  if (![32, 128, 256].includes(settings.samples)) throw new Error('Choose 32, 128, or 256 samples.');
  const total = totalExportFrames(scene);
  if (!Number.isSafeInteger(settings.frame) || settings.frame < 1 || settings.frame > total) throw new Error('Choose a frame inside the current film.');
  if (!Number.isFinite(scene.render.fps) || scene.render.fps <= 0) throw new Error('The film needs a valid frame rate.');
  return {kind: settings.mode === 'still' ? 'still' : 'reel', format: settings.format, filename: exportFilename(settings.filename), frame: settings.frame, ...dimensions, samples: settings.samples};
}
export function primaryExportArtifact(job: ExportJob): ExportArtifact | undefined {
  if (job.state !== 'succeeded') return undefined;
  const name = job.primaryArtifact || exportFormats[job.format ?? (job.kind === 'still' ? 'png' : 'mp4')].artifact;
  return job.artifacts.find(artifact => artifact.name === name);
}
export function exportDownloadUrl(url: string): string {return `${url}${url.includes('?') ? '&' : '?'}download=1`;}
export function exportProgress(job: ExportJob): {completed: number; total: number; ratio: number} {
  const total = Number.isFinite(job.totalFrames) ? Math.max(0, job.totalFrames) : 0;
  const completed = Number.isFinite(job.completedFrames) ? Math.min(total, Math.max(0, job.completedFrames)) : 0;
  return {completed, total, ratio: total > 0 ? completed / total : 0};
}
export function exportBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return '';
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

export type PairedExportJob = {
  id: string; kind: 'still' | 'reel'; state: string; sourceDigest?: string; frame?: number;
  children: {a?: ExportJob; b?: ExportJob}; artifacts: ExportArtifact[]; createdAt?: string; error?: string | null;
};
/** Pair output stays one visible job while preserving both children's real frame counts and links. */
export function normalizePairExportJob(pair: PairedExportJob): ExportJob {
  const children = [pair.children.a, pair.children.b].filter((item): item is ExportJob => !!item), first = children[0];
  return {...pair, paired: true, format: pair.kind === 'still' ? 'png' : 'mp4', filename: first?.filename || 'gesso',
    width: first?.width, height: first?.height, fps: first?.fps, samples: first?.samples,
    completedFrames: children.reduce((total, child) => total + exportProgress(child).completed, 0),
    totalFrames: children.reduce((total, child) => total + exportProgress(child).total, 0),
    canCancel: children.some(child => ['queued', 'running'].includes(child.state)),
    primaryArtifact: 'pair.zip',
    artifacts: [...pair.artifacts, ...(['a', 'b'] as const).flatMap(side => (pair.children[side]?.artifacts ?? []).map(artifact => ({...artifact, name: `${side}/${artifact.name}`})))],
  };
}
export function combinedExportJobs(jobs: ExportJob[], pairs: PairedExportJob[]): ExportJob[] {
  const children = new Set(pairs.flatMap(pair => [pair.children.a?.id, pair.children.b?.id]).filter(Boolean));
  return [...jobs.filter(job => !children.has(job.id)), ...pairs.map(normalizePairExportJob)].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
