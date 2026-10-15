// Read-only review of explicitly listed completed navigation runs; never starts a worker.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

assert.ok(process.env.STUDIO_REPORT, 'Set STUDIO_REPORT to the navigation acceptance JSON');
const report = JSON.parse(await readFile(process.env.STUDIO_REPORT, 'utf8'));
const base = process.env.STUDIO_URL || report.base;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
assert.ok(report.results.length > 0 && report.results.length <= 6);
assert.equal(report.results.length, report.cases.length, 'Every configured case must have a result');
const evidence = process.env.STUDIO_EVIDENCE || path.join(path.dirname(process.env.STUDIO_REPORT), 'replay-review');
await mkdir(evidence, {recursive: true});
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({viewport: {width: 1512, height: 1100}});
const errors = [], failed = [], reviews = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
async function seek(time) {
  await page.evaluate(t => window.__studio.seek(t), time);
  await page.waitForFunction(t => window.__workbench.state.sensors?.session_id === window.__studio.state.sessionId &&
    Math.abs(window.__workbench.state.sensors.cursor_s - t) < 1e-6, time);
}
try {
  for (const result of report.results) {
    assert.ok(['completed', 'failed'].includes(result.status), 'Only terminal runs can be reviewed');
    const id = result.job_id, source = result.summary.report;
    const url = `${base}/?session=${encodeURIComponent(id)}&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1`;
    await page.goto(url);
    await page.waitForFunction(({id, count}) => window.__studio?.state.sessionId === id &&
      document.querySelector('#loading-overlay').hidden && window.__studio.state.session.frames.length === count,
      {id, count: source.control_steps}, {timeout: 60000});
    const metadata = await page.evaluate(() => window.__studio.state.session.metadata);
    assert.deepEqual(metadata.goal_xy, result.requested.goal_xy);
    assert.equal(metadata.test_result.outcome, source.outcome);
    assert.equal(metadata.command_path_enabled, false);
    assert.equal(await page.evaluate(() => window.__studio.state.tab), 'health');
    assert.ok(await page.locator('#layer-perception').isChecked());
    const samples = [];
    const times = [['middle', Number((metadata.duration_s * .6).toFixed(3))], ['end', metadata.duration_s]];
    const peak = await page.evaluate(() => window.__studio.state.session.frames.reduce((best, frame) =>
      (frame.health?.contact_force_n ?? 0) > best.force_n ? {time: frame.time, force_n: frame.health.contact_force_n} : best,
      {time: null, force_n: 0}));
    if (peak.force_n > 0) times.push(['peak-contact', peak.time]);
    for (const [label, time] of times) {
      await seek(time);
      assert.equal(await page.locator('#sensor-dock [data-sensor-card]').count(), 1);
      const snapshot = await page.evaluate(() => window.__workbench.state.sensors);
      const sensors = snapshot.sensors.filter(sensor => ['lidar_filtered', 'map_support'].includes(sensor.id));
      assert.equal(sensors.length, 2);
      assert.ok(sensors.every(sensor => sensor.available && Number.isFinite(sensor.sample_time_s) && sensor.sample_time_s <= time + 1e-6));
      assert.equal(await page.locator('#recording-warning').isVisible(), metadata.recording_complete === false);
      const screenshot = path.join(evidence, `${result.name}-${label}.png`);
      await page.screenshot({path: screenshot, fullPage: true});
      const health = await page.evaluate(() => window.__studio.state.frame.health);
      if (label === 'peak-contact') {
        assert.equal(health.contact_force_n, peak.force_n);
        assert.ok(health.contact_interval.end_s <= time + 1e-6);
      }
      samples.push({label, cursor_s: time, screenshot, contact_force_n: health.contact_force_n,
        sensors: sensors.map(sensor => ({id: sensor.id, source_time_s: sensor.sample_time_s, age_ms: sensor.age_ms}))});
    }
    await seek(.2);
    await page.click('#play');
    await page.waitForFunction(() => window.__studio.state.time > .35);
    await page.click('#play');
    await seek(metadata.duration_s - .02);
    await page.click('#play');
    await page.waitForFunction(() => window.__studio.state.playing && window.__studio.state.time < .5);
    await page.click('#play');
    const middle = samples[0].cursor_s;
    reviews.push({name: result.name, id, outcome: source.outcome, frames: source.control_steps, samples,
      replay_url: `${url}&time=${middle.toFixed(3)}&play=1`, half_speed_playback: true, replay_loop: true});
    await writeFile(path.join(evidence, 'replay-review.json'), JSON.stringify({base, reviews, errors, failed}, null, 2));
    console.log(`${result.name}: ${source.outcome}, ${source.control_steps} decoded frames, synchronized LiDAR/map/Health, playback and loop verified`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(failed, []);
} catch (error) {
  await page.screenshot({path: path.join(evidence, 'review-failure.png'), fullPage: true});
  throw error;
} finally {
  await browser.close();
}
