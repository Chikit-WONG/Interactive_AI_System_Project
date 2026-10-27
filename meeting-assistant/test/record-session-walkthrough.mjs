// Records only an isolated browser page. No .env, physical capture, real feedback, or AI calls.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.mjs';
import { APP_VERSION } from '../version.mjs';

const require = createRequire(import.meta.url);
const runtimeModules = 'C:/Users/chikitwong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(project, 'output/2026-10-22_session_controls');
const testOut = path.join(project, 'meeting-assistant/test-output');
await mkdir(out, { recursive: true });
await mkdir(testOut, { recursive: true });
const temporary = await mkdtemp(path.join(testOut, 'session-recording-'));
// Reuse the project's existing encoder through a process-local Playwright path.
// Installed Edge remains the browser; this does not install or alter any system browser.
const browserRegistry = JSON.parse(await readFile(path.join(runtimeModules, 'playwright-core/browsers.json'), 'utf8'));
const encoderRevision = browserRegistry.browsers.find(item => item.name === 'ffmpeg').revision;
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(testOut, 'recording-browser-tools');
const encoderDirectory = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, `ffmpeg-${encoderRevision}`);
await mkdir(encoderDirectory, { recursive: true });
const encoderPath = path.join(encoderDirectory, 'ffmpeg-win64.exe');
await copyFile(path.join(project, 'tmp/video_python/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe'), encoderPath);
const { chromium } = require(path.join(runtimeModules, 'playwright'));
let providerCalls = 0, browser;
const errors = [], phases = [];
const server = createApp({ apiKey: '', feedbackDirectory: path.join(temporary, 'feedback') }, () => {
  providerCalls++;
  throw new Error('This recording must never invoke a provider.');
});
const started = performance.now();
const phase = name => phases.push({ name, wallMs: Math.round(performance.now() - started) });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = async () => (await (await fetch(`${origin}/api/state`)).json());
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    recordVideo: { dir: temporary, size: { width: 1360, height: 900 } }
  });
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  const video = page.video();
  const recordingStarted = performance.now();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#session-state').textContent === '会话未开始');
  assert.equal(await page.locator('#meeting-clock').textContent(), '00:00');
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).keyConfigured, false);
  phase('initial_idle_00_00_no_key');
  await page.screenshot({ path: path.join(out, '01_initial_idle.png') });
  await page.waitForTimeout(3200);

  await page.locator('#start-session').click();
  await page.waitForFunction(() => document.querySelector('#session-state').textContent === '会话进行中');
  phase('session_started');
  await page.waitForTimeout(2500);
  await page.locator('#replay-tab').click();
  await page.locator('#load-replay').click();
  await page.waitForFunction(() => document.querySelector('#user-name').value === '数据负责人');
  await page.locator('#replay-speed').selectOption('4');
  await page.waitForTimeout(1500);
  await page.locator('#start-replay').click();
  phase('fictional_script_replay_4x');
  await page.waitForTimeout(8200);
  let received = await state();
  assert(received.utterances.length >= 3);
  assert(received.utterances.every(item => item.source === 'rehearsal'));
  assert.equal(received.alerts.length, 0);
  await page.locator('#transcript-list').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1700);

  await page.locator('#stop-session').click();
  await page.waitForFunction(() => document.querySelector('#session-state').textContent === '会话已停止');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  const stopped = await state();
  const stoppedClock = await page.locator('#meeting-clock').textContent();
  phase('stopped_clock_and_replay_preserved');
  await page.waitForTimeout(4200);
  assert.equal(await page.locator('#meeting-clock').textContent(), stoppedClock);
  assert.equal((await state()).utterances.length, stopped.utterances.length);
  await page.screenshot({ path: path.join(out, '02_stopped.png') });

  await page.locator('#start-session').click();
  await page.waitForFunction(() => document.querySelector('#session-state').textContent === '会话进行中');
  phase('resumed_without_automatic_replay_or_capture');
  await page.waitForTimeout(2500);
  await page.locator('#monitor-input').scrollIntoViewIfNeeded();
  assert.match(await page.locator('#monitor-input').textContent(), /已暂停.*未采集声音/);
  assert(await page.locator('#stop-replay').isDisabled());
  assert(await page.locator('#analyze-button').isDisabled());
  assert.match(await page.locator('#monitor-analysis').textContent(), /未配置 API/);
  await page.waitForTimeout(2000);
  assert.equal((await state()).utterances.length, stopped.utterances.length);

  await page.locator('#feedback-open').click();
  assert(await page.locator('#feedback-dialog').evaluate(node => node.open));
  assert.equal(await page.locator('#feedback-message').inputValue(), '');
  assert.equal(await page.locator('#feedback-stage').inputValue(), '');
  phase('empty_feedback_form_not_submitted');
  await page.screenshot({ path: path.join(out, '03_empty_feedback.png') });
  await page.waitForTimeout(5500);
  assert.equal(providerCalls, 0);
  assert.deepEqual(errors, []);
  const finalState = await state();
  assert.equal(finalState.meetingId, stopped.meetingId);
  assert.equal(finalState.alerts.length, 0);
  await context.close();
  const recordingWallMs = Math.round(performance.now() - recordingStarted);
  const videoPath = path.join(out, 'session_controls_demo.webm');
  await video.saveAs(videoPath);
  await video.delete();
  const { size } = await stat(videoPath);
  assert(size > 10000);
  const decoded = spawnSync(encoderPath, ['-hide_banner', '-i', videoPath, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(decoded.status, 0, 'video must decode successfully');
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(decoded.stderr);
  assert(duration, 'encoder must report media duration');
  const mediaDurationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  assert(mediaDurationSeconds >= 30 && mediaDurationSeconds <= 45);
  const report = {
    appVersion: APP_VERSION, source: 'isolated_local_ui_walkthrough', providerCalls,
    input: 'fictional_rehearsal_script_at_4x', realAudioCaptured: false,
    realTencentMeetingUsed: false, feedbackSubmitted: false, viewport: { width: 1360, height: 900 },
    createdAt: new Date().toISOString(), recordingWallMs, mediaDurationSeconds,
    durationNote: 'Duration read from existing FFmpeg metadata; full video decoded to null output successfully.',
    fileBytes: size, utteranceCount: finalState.utterances.length, phases, errors
  };
  await writeFile(path.join(out, 'recording_metadata.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(out, '说明.txt'), `会话启停操作示范（版本 ${APP_VERSION}）\n\n这是独立本机测试服务的界面操作录像，不是最终的多人腾讯会议录像。\n未配置 DeepSeek API Key，未调用模型，也没有预设 AI 回答。\n输入来自项目已有的虚构排练剧本，以 4 倍速度回放；没有采集真实屏幕、麦克风或会议声音。\n\n演示顺序：\n1. 未开始时保持 00:00。\n2. 开始会话，载入剧本并回放几条发言。\n3. 停止会话，计时冻结、回放停止，已有记录保留。\n4. 继续同一会话，计时恢复，但不自动启动回放或采集。\n5. 打开空白反馈表，没有提交任何反馈。\n\n录像没有配音；旁边的 recording_metadata.json 记录阶段时间和文件大小。\n视频时长 ${mediaDurationSeconds.toFixed(2)} 秒（从项目已有 FFmpeg 读取），已完整解码检查。\n`, 'utf8');
  console.log(JSON.stringify({ videoPath, ...report }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => { if (!server.listening) return resolve(); server.closeAllConnections(); server.close(resolve); });
}
