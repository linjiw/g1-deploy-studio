// Replay of real robot sessions recorded by the deploy kit's console (g1deploy/recorder.py): the catalog lists them
// under "Robot sessions (deploy kit)", the robot is posed from measured joints and the estimated pose, the evidence
// level says what it is, scrubbing works, and nothing errors. Put sessions under <data root>/robot-sessions.
//   STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/replay_robot_session.mjs
import { BASE, launch, recorder, assert, api, open, seek, sleep } from './harness.mjs';

const R = recorder('replay_robot_session');
const { browser, context } = await launch();
const page = await context.newPage();
R.watch(page);
const list = (await api(page, '/api/sessions')).body?.sessions ?? [];
const robot = list.filter(s => s.group === 'Robot sessions (deploy kit)');

await R.check('RS1', 'The catalog lists deploy-kit robot sessions, robot-day directories included', async () => {
  assert(robot.length >= 1, `robot sessions ${JSON.stringify(list.map(s => s.id))}`);
  assert(robot.every(s => s.robot === 'real' && s.available), JSON.stringify(robot));
  return { ids: robot.map(s => s.id) };
});

for (const [k, s] of robot.entries()) {
  await R.check(`RS${k + 2}`, `${s.id}: opens, poses the robot, labels the evidence, scrubs`, async () => {
    await open(page, s.id);
    const info = await page.evaluate(() => {
      const m = window.__studio.state.session.metadata;
      return { kind: m.recording_kind, robot: m.robot, pose: m.pose_source, frames: window.__studio.state.session.frames.length,
        duration: m.duration_s, model: !!window.__studio.robot };
    });
    assert(info.kind === 'robot-console-session' && info.robot === 'real' && info.model, JSON.stringify(info));
    await seek(page, info.duration / 2);
    await sleep(400);
    const badge = await page.locator('#mode-badge').innerText();
    assert(/robot session \(deploy kit\) · M4/.test(badge), `badge "${badge}"`);
    assert(/M4 · recorded real robot session/.test(await page.locator('#mode-badge').getAttribute('title')), 'badge title');
    await R.shot(s.id.slice(0, 40));
    return info;
  });
}

await R.save();
await browser.close();
