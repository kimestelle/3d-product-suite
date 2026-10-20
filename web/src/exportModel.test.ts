import {describe, expect, it} from 'vitest';
import {combinedExportJobs, normalizePairExportJob, exportBlockReason, exportDimensions, exportDownloadUrl, exportFilename, exportProgress, formatsForMode, makeExportPayload, primaryExportArtifact, totalExportFrames, type ExportJob, type ExportScene} from './exportModel';
const scene: ExportScene = {render: {width: 1080, height: 1920, fps: 24, samples: 32}, shots: [{endFrame: 120}, {endFrame: 240}, {endFrame: 360}]};
const settings = {mode: 'still' as const, format: 'png' as const, filename: 'Nessino.png', frame: 172, scale: 1 as const, samples: 128};
const job: ExportJob = {id: 'render-1', kind: 'reel', state: 'succeeded', format: 'prores', completedFrames: 360, totalFrames: 360, artifacts: [{name: 'film.mov', url: '/api/jobs/render-1/files/film.mov'}, {name: 'scene.blend', url: '/api/jobs/render-1/files/scene.blend'}]};

describe('Export settings and deliverables', () => {
  it('exports the full movie duration including gaps and a blank tail', () => {
    const movie = {...scene, render: {...scene.render, durationFrames: 480}};
    expect(totalExportFrames(movie)).toBe(480);
    expect(makeExportPayload(movie, {...settings, frame: 450}).frame).toBe(450);
    expect(() => makeExportPayload(movie, {...settings, frame: 481})).toThrow('current film');
    expect(totalExportFrames({...scene, shots: [...scene.shots!].reverse()})).toBe(360);
  });
  it('snapshots the selected frame and samples without modifying the working composition', () => {
    const before = structuredClone(scene);
    expect(makeExportPayload(scene, settings)).toEqual({kind: 'still', format: 'png', filename: 'Nessino', frame: 172, width: 1080, height: 1920, samples: 128});
    expect(scene).toEqual(before);
  });
  it('scales both image axes together without changing the camera aspect', () => {
    for (const scale of [.5, 1, 2] as const) {
      const {width, height} = exportDimensions(scene, scale);
      expect(width / height).toBe(scene.render.width / scene.render.height);
      expect(width).toBe(scene.render.width * scale);
    }
  });
  it('rejects incompatible half sizes instead of quietly rounding and distorting the frame', () => {
    const unusual = {...scene, render: {...scene.render, width: 1002, height: 1000}};
    expect(() => exportDimensions(unusual, .5)).toThrow('even dimensions');
    expect(exportDimensions(unusual, 1)).toEqual({width: 1002, height: 1000});
    expect(() => exportDimensions({...scene, render: {...scene.render, width: 10000}}, 2)).toThrow('16,384');
  });
  it('does not let a still format become a video export or an unsupported comparison format through stale state', () => {
    expect(() => makeExportPayload(scene, {...settings, mode: 'video'})).toThrow('format');
    expect(() => makeExportPayload({...scene, comparison: {}}, {...settings, format: 'jpeg'})).toThrow('format');
    expect(formatsForMode('still', true)).toEqual(['png']);
    expect(formatsForMode('video', true)).toEqual(['mp4']);
    expect(makeExportPayload(scene, {...settings, mode: 'video', format: 'png-sequence'}).kind).toBe('reel');
  });
  it('rejects invalid scope or sample values before queueing work', () => {
    for (const frame of [0, 361, 1.5, NaN]) expect(() => makeExportPayload(scene, {...settings, frame})).toThrow('frame');
    expect(() => makeExportPayload(scene, {...settings, samples: 0})).toThrow('samples');
  });
  it('keeps download names as stems and prevents path/header fragments', () => {
    expect(exportFilename(' Campaign.jpeg ')).toBe('Campaign');
    expect(exportFilename('../../red/blue\r\nname.mp4')).toBe('red-blue-name');
    expect(exportFilename(' .- ')).toBe('gesso');
    expect(exportFilename('a'.repeat(90))).toHaveLength(80);
    expect(exportFilename('Nessino revised')).toBe('Nessino revised');
  });
  it('allows PNG and PNG sequences with Blender alone but explains encoder-dependent choices', () => {
    const caps = {blenderAvailable: true, ffmpegAvailable: false, ffmpegIssue: 'Encoder is unavailable'};
    expect(exportBlockReason(caps, 'png')).toBe('');
    expect(exportBlockReason(caps, 'png-sequence')).toBe('');
    for (const format of ['jpeg', 'webp', 'mp4', 'prores'] as const) expect(exportBlockReason(caps, format)).toBe('Encoder is unavailable');
    expect(exportBlockReason(caps, 'png', 'Save the material preview first.')).toBe('Save the material preview first.');
    expect(exportBlockReason({}, 'png')).toBe('Checking the local renderer…');
  });
  it('only offers a verified primary download after success, preserving the selected format', () => {
    expect(primaryExportArtifact(job)?.name).toBe('film.mov');
    expect(primaryExportArtifact({...job, state: 'running'})).toBeUndefined();
    expect(primaryExportArtifact({...job, artifacts: [job.artifacts[1]]})).toBeUndefined();
    expect(primaryExportArtifact({...job, paired: true, primaryArtifact: 'comparison.zip', artifacts: [{name: 'comparison.zip', url: '/pair.zip'}]})?.url).toBe('/pair.zip');
    expect(exportDownloadUrl('/api/jobs/1/files/film.mp4')).toBe('/api/jobs/1/files/film.mp4?download=1');
    expect(exportDownloadUrl('/pair.zip?revision=1')).toBe('/pair.zip?revision=1&download=1');
  });
  it('keeps comparison children out of history while retaining both frame counts and downloads', () => {
    const a = {...job, id: 'a', state: 'succeeded', filename: 'Lamp', format: 'mp4' as const, completedFrames: 360};
    const b = {...job, id: 'b', state: 'running', format: 'mp4' as const, completedFrames: 72};
    const pair = {id: 'pair', kind: 'reel' as const, state: 'running', children: {a, b}, artifacts: [{name: 'pair.zip', url: '/pair.zip'}]};
    const normalized = normalizePairExportJob(pair);
    expect(normalized.completedFrames).toBe(432); expect(normalized.totalFrames).toBe(720);
    expect(normalized.canCancel).toBe(true); expect(normalized.filename).toBe('Lamp');
    expect(normalized.artifacts.some(item => item.name === 'a/scene.blend')).toBe(true);
    expect(combinedExportJobs([a, b, job], [pair]).map(item => item.id).sort()).toEqual(['pair', 'render-1']);
    expect(primaryExportArtifact({...normalized, state: 'succeeded'})?.name).toBe('pair.zip');
  });
  it('reports actual frame completion without inventing progress during encoding or missing totals', () => {
    expect(exportProgress({...job, completedFrames: 90})).toEqual({completed: 90, total: 360, ratio: .25});
    expect(exportProgress({...job, state: 'running'})).toEqual({completed: 360, total: 360, ratio: 1});
    expect(exportProgress({...job, totalFrames: 0, completedFrames: 8})).toEqual({completed: 0, total: 0, ratio: 0});
    expect(exportProgress({...job, completedFrames: NaN})).toEqual({completed: 0, total: 360, ratio: 0});
  });
});
