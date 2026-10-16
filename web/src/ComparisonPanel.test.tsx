import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComparisonJobList } from './ComparisonPanel';

function renderJobs(job: any, digest = 'current-scene') {
  return renderToStaticMarkup(<ComparisonJobList jobs={[job]} digest={digest} busy={false} onControl={() => {}}/>);
}

function buttons(html: string) {
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)]
    .map(match => ({ attributes: match[1], label: match[2] }));
}

function successfulPair() {
  return {
    id: 'pair-42', kind: 'still', state: 'succeeded', frame: 180,
    sourceDigest: 'current-scene', alignmentStatus: 'reviewed',
    artifacts: [{ name: 'comparison.zip', url: '/api/comparison-renders/pair-42/files/comparison.zip' }],
    children: {
      a: { id: 'render-a', state: 'succeeded', completedFrames: 1, totalFrames: 1,
        artifacts: [{ name: 'still.png', url: '/api/jobs/render-a/files/still.png' }] },
      b: { id: 'render-b', state: 'succeeded', completedFrames: 1, totalFrames: 1,
        artifacts: [{ name: 'still.png', url: '/api/jobs/render-b/files/still.png' }] },
    },
  };
}

describe('comparison render controls and downloads', () => {
  it('allows cancelling the live child even after the aggregate pair has failed', () => {
    // The queue reports failure as soon as A fails; B can still consume render time.
    const job = successfulPair();
    job.state = 'failed';
    job.children.a.state = 'failed'; job.children.a.completedFrames = 0;
    job.children.b.state = 'running'; job.children.b.completedFrames = 0;
    const html = renderJobs(job);
    const actions = buttons(html);
    expect(actions.map(action => action.label)).toEqual(expect.arrayContaining(['Cancel both', 'Resume pair']));
    expect(actions.find(action => action.label === 'Cancel both')?.attributes).not.toContain('disabled');
    expect(actions.find(action => action.label === 'Resume pair')?.attributes).not.toContain('disabled');
    expect(html).toContain('Environment A · failed');
    expect(html).toContain('Environment B · running');
  });

  it('offers the paired bundle and distinct A/B outputs with the saved placement review', () => {
    const html = renderJobs(successfulPair());
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
      .map(match => ({ url: match[1], label: match[2] }));
    expect(links).toEqual(expect.arrayContaining([
      { url: '/api/comparison-renders/pair-42/files/comparison.zip', label: 'comparison.zip ↗' },
      { url: '/api/jobs/render-a/files/still.png', label: 'A · still.png ↗' },
      { url: '/api/jobs/render-b/files/still.png', label: 'B · still.png ↗' },
    ]));
    expect(new Set(links.map(link => link.url)).size).toBe(3);
    expect(html).toMatch(/class="comparison-status reviewed">Placement reviewed<\/span>/);
    expect(html).not.toContain('Earlier scene revision');
    expect(buttons(html)).toEqual([]);
  });

  it('marks outputs from an earlier scene as stale while keeping their downloads available', () => {
    const html = renderJobs(successfulPair(), 'newer-scene-after-placement-edit');
    expect(html).toMatch(/class="stale">Earlier scene revision<\/p>/);
    expect(html).toContain('href="/api/comparison-renders/pair-42/files/comparison.zip"');
    expect(html).toContain('href="/api/jobs/render-a/files/still.png"');
    expect(html).toContain('href="/api/jobs/render-b/files/still.png"');
  });
});
