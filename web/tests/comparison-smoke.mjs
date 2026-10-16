/** Browser integration: requires the built local server; never calls a provider. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.PRODUCT_SUITE_URL || 'http://127.0.0.1:8787';
const output = new URL('../../.cache/comparison-qa/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const request = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, { method, headers: { 'X-Product-Suite': '1' }, data });
  assert(response.ok(), `${path}: ${await response.text()}`);
  return response.json();
};
const ready = () => page.waitForFunction(() => !document.querySelector('.glass-button')?.disabled, { timeout: 90000 });
try {
  const bootstrap = await request('/api/bootstrap');
  const source = process.env.PRODUCT_SUITE_PROJECT
    ? await request(`/api/projects/${process.env.PRODUCT_SUITE_PROJECT}`) : bootstrap.project;
  const project = await request('/api/projects', 'POST', { name: 'A/B browser verification', scene: source.scene });
  await page.goto(origin);
  await page.getByRole('button', { name: 'World', exact: true }).click();
  if (!source.scene.comparison) await page.getByRole('button', { name: 'Enable A/B comparison', exact: true }).click();
  await ready();
  assert.equal(await page.getByLabel('Frame', { exact: true }).inputValue(), '1');
  await page.getByLabel('Frame', { exact: true }).fill(source.scene.shots.some(s => s.startFrame === 241) ? '241' : '1');
  const canvases = page.locator('.comparison-pane:not(.pane-hidden) canvas');
  assert.equal(await canvases.count(), 2);
  for (const box of await canvases.evaluateAll(nodes => nodes.map(node => ({ w: node.clientWidth, h: node.clientHeight })))) {
    assert(Math.abs(box.w / box.h - 9 / 16) < .01, JSON.stringify(box));
  }
  await page.screenshot({ path: output + 'split.png', fullPage: true });
  await page.getByRole('button', { name: 'View B', exact: true }).click();
  assert.equal(await page.locator('.comparison-pane:not(.pane-hidden)').count(), 1);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type=range]')?.value) > 242);
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.getByLabel('Frame', { exact: true }).fill('241');
  await page.getByText('Floor and known distance · A', { exact: true }).click();
  await page.getByRole('button', { name: 'Pick floor · A', exact: true }).click();
  const canvas = page.locator('[aria-label="Environment A scene"] canvas');
  const bounds = await canvas.boundingBox();
  // Lower side pixels target the room floor outside the centered exact product/plinth.
  for (const [x, y] of [[.2, .82], [.8, .82], [.15, .72], [.85, .72]]) {
    if (!await page.locator('.pick-hint').count()) break;
    await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    await page.waitForTimeout(150);
  }
  assert.equal(await page.locator('.pick-hint').count(), 0, 'World floor was not picked');
  const placementResponse = page.waitForResponse(response => response.url().endsWith('/api/comparison/calibrate') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Apply placement · A', exact: true }).click();
  const calibrated = await (await placementResponse).json();
  assert(calibrated.scene.comparison.calibration.a.sourceFloorPoint);
  assert.equal(await page.getByLabel('Yaw A', { exact: true }).inputValue(), '');
  await ready();
  const alignedY = await page.getByLabel('Y translation A', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready();
  assert.equal(await page.getByLabel('Y translation A', { exact: true }).inputValue(), alignedY);
  await page.getByRole('button', { name: 'Mark placement reviewed', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Placement review saved in this scene', exact: true }).waitFor();
  await page.getByLabel('Y translation B', { exact: true }).fill(String(Number(await page.getByLabel('Y translation B', { exact: true }).inputValue()) + .01));
  await ready();
  assert(await page.getByRole('button', { name: 'Mark placement reviewed', exact: true }).isEnabled());
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await page.getByText('Revision saved', { exact: true }).waitFor();
  const saved = await request(`/api/projects/${project.id}`);
  assert.deepEqual(saved.scene.comparison.calibration.a.sourceFloorPoint, calibrated.scene.comparison.calibration.a.sourceFloorPoint);
  assert.notEqual(saved.scene.comparison.alternative.asset.translationM[1], calibrated.scene.comparison.alternative.asset.translationM[1]);
  await page.reload();
  await ready();
  await page.getByRole('button', { name: 'World', exact: true }).click();
  assert.equal(await page.getByLabel('Y translation A', { exact: true }).inputValue(), alignedY);
  await page.getByText('Floor and known distance · A', { exact: true }).click();
  assert(!await page.locator('.comparison-side-controls').first().getByText('Floor: No point selected', { exact: true }).count());
  await page.getByLabel('Frame', { exact: true }).fill('241');
  // Exercise the real UI dispatch with a bounded local smoke render profile.
  await page.route('**/api/comparison-renders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const data = route.request().postDataJSON();
    await route.continue({ postData: JSON.stringify({ ...data, width: 180, height: 320, samples: 4 }) });
  });
  const exportResponse = page.waitForResponse(response => response.url().endsWith('/api/comparison-renders') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Render matching stills', exact: false }).click();
  const pair = await (await exportResponse).json();
  assert.equal(pair.kind, 'still');
  assert.equal(pair.frame, 241);
  let result;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    result = await request(`/api/comparison-renders/${pair.id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(result.state)) break;
    await page.waitForTimeout(1000);
  }
  assert.equal(result?.state, 'succeeded', JSON.stringify(result));
  assert(result.artifacts.some(artifact => artifact.name === 'pair.zip'));
  const manifest = await request(`/api/comparison-renders/${pair.id}/files/comparison.json`);
  assert.equal(manifest.children.a.renderProfile.width, 180);
  assert.deepEqual(manifest.children.a.renderProfile, manifest.children.b.renderProfile);
  assert.equal(manifest.children.a.rendererDigest, manifest.children.b.rendererDigest);
  assert.equal(manifest.alignmentStatus, 'draft');
  await page.screenshot({ path: output + 'paired-export.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile overflow');
  await page.screenshot({ path: output + 'mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(await page.getByRole('alert').count(), 0);
  const report = { projectId: project.id, pairId: pair.id, checks: ['shared frame and portrait gates', 'B-only playback', 'world-only floor pick', 'calibration undo/redo', 'stale placement review', 'save/reopen with picks', 'paired UI export', 'matching profiles and renderer', 'mobile overflow'], screenshots: output };
  await writeFile(output + 'report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: output + 'failure.png', fullPage: true });
  console.error('Browser errors', errors, await page.getByRole('alert').allTextContents());
  throw error;
} finally {
  await browser.close();
}
