// Analysis-control acceptance on an isolated server and fake analyzer.
// No .env access, real provider calls, physical audio, or participant feedback.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.mjs';
import { ApiError } from '../deepseek.mjs';
import { APP_VERSION } from '../version.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/chikitwong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');
await mkdir(out, { recursive: true });
const checks = [], errors = [], calls = [];
let failNext = false, browser;
const server = createApp({ apiKey: 'isolated-test-only', model: 'analysis-controls-test-double' }, async (_config, snapshot) => {
  const fails = failNext;
  failNext = false;
  calls.push({ snapshot: structuredClone(snapshot), failed: fails });
  if (fails) throw new ApiError(503, 'TEST_ANALYSIS_FAILURE', '自动化测试：服务暂不可用，请手动重试。');
  return { summary: `自动化测试：已处理至 ${snapshot.new_utterance_ids.at(-1)}。`, items: [] };
});

async function until(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = async () => (await (await fetch(`${origin}/api/state`)).json());
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  await page.goto(origin);
  const reason = () => page.locator('#analysis-ready-reason').textContent();
  const advance = async ms => {
    await page.clock.runFor(ms);
    // Network handlers use the real Node event loop; give completed requests a turn.
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  const screenshot = name => page.screenshot({ path: path.join(out, `analysis-controls-${name}.png`), fullPage: true });
  async function addText(text) {
    const before = (await state()).utterances.length;
    await page.locator('#transcript-input').fill(text);
    await page.locator('#add-transcript').click();
    await until(async () => (await state()).utterances.length === before + 1 &&
      await page.locator('#transcript-count').textContent() === `${before + 1} 条`, 'new transcript reaches server and UI');
  }
  async function completedAt(id) {
    await until(async () => {
      const current = await state();
      return current.analysisState.lastAnalyzedUtteranceId === id && !current.analysisState.running &&
        (await page.locator('#analysis-status').textContent()).includes('分析已更新');
    }, `analysis completed through ${id}`);
  }
  await until(async () => await page.locator('#session-state').textContent() === '会话未开始', 'initial idle state');
  assert(await page.locator('#analyze-button').isDisabled());
  assert.match(await reason(), /开始|未开始/);
  assert.equal(await page.locator('#analysis-next-step').isHidden(), false);
  await screenshot('01-idle');
  await page.locator('#analysis-next-step').click();
  await until(async () => await page.locator('#session-state').textContent() === '会话进行中', 'next step starts idle session');
  assert.equal((await state()).utterances.length, 0);
  assert.match(await reason(), /称呼|姓名|职责|负责/);
  await page.locator('#analysis-next-step').click();
  assert(['user-name', 'user-responsibilities'].includes(await page.evaluate(() => document.activeElement.id)));
  await page.locator('#user-name').fill('自动化测试角色');
  await page.locator('#user-responsibilities').fill('核对虚构排练时间，不负责其他事项。');
  await advance(700);
  await until(async () => (await state()).profile.responsibilities.length > 0, 'initial complete profile saved');
  assert(await page.locator('#analyze-button').isDisabled());
  assert.match(await reason(), /发言|记录|内容|职责|称呼/);
  await screenshot('02-no-records');
  checks.push('Disabled analysis explains idle/empty states and offers a working start action');

  const pendingText = '主持人：这是一条仅保留在输入框里的虚构测试发言。';
  await page.locator('#transcript-input').fill(pendingText);
  await advance(15000);
  assert.equal((await state()).utterances.length, 0);
  assert.equal(calls.length, 0, 'typing alone must never send data to the analyzer');
  assert(await page.locator('#analyze-button').isDisabled());
  assert.match(await reason(), /加入|提交|输入框/);
  await screenshot('03-pending-input');
  await page.locator('#analysis-next-step').click();
  await until(async () => (await state()).utterances.length === 1, 'next step adds pending text');
  assert.equal((await state()).utterances[0].text, pendingText.split('：')[1]);
  assert.equal(await page.locator('#transcript-input').inputValue(), '');
  assert.equal(calls.length, 0);
  checks.push('Typing is not submission; pending-input guidance adds the original text without analyzing it');

  await page.locator('#user-responsibilities').fill('');
  await advance(700);
  assert(await page.locator('#analyze-button').isDisabled());
  assert.match(await reason(), /称呼|姓名|职责|角色|负责/);
  await page.locator('#analysis-next-step').click();
  assert(['user-name', 'user-responsibilities'].includes(await page.evaluate(() => document.activeElement.id)));
  await page.locator('#user-name').fill('自动化测试角色');
  await advance(700);
  assert(await page.locator('#analyze-button').isDisabled(), 'name alone is not a complete profile');
  if (!(await page.locator('#auto-analyze').isDisabled())) {
    await page.locator('#auto-analyze').check();
    await advance(15000);
    assert.equal(calls.length, 0, 'incomplete responsibilities cannot issue automatic requests');
    await page.locator('#auto-analyze').uncheck();
  }
  await page.locator('#user-responsibilities').fill('核对虚构排练时间，不负责其他事项。');
  await advance(700);
  await until(async () => (await state()).profile.responsibilities.length > 0 && !(await page.locator('#analyze-button').isDisabled()), 'complete profile enables manual analysis');
  assert.match(await page.locator('#analyze-button').textContent(), /立即分析一次/);
  await page.locator('#analyze-button').click();
  await completedAt('u1');
  assert.equal(calls.length, 1);
  checks.push('Missing profile directs focus to required settings; complete profile enables one explicit analysis');

  assert.equal(await page.locator('#auto-analyze').isChecked(), false);
  await page.locator('#auto-analyze').check();
  await addText('主持人：请确认明天下午的测试时间。');
  await advance(3900);
  assert.equal(calls.length, 1, 'automatic analysis waits for the quiet interval');
  await advance(300);
  await completedAt('u2');
  assert.equal(calls.length, 2);
  assert.equal(await page.locator('#auto-analyze').isChecked(), true);
  await advance(9000);
  assert.equal(calls.length, 2, 'unchanged text is not sent repeatedly');
  checks.push('One auto-analysis opt-in processes new text after four seconds and does not repeat unchanged input');

  const beforeContinuous = calls.length;
  const continuousStart = await page.evaluate(() => Date.now());
  await addText('成员甲：持续发言测试第一段。');
  for (const text of ['成员乙：持续发言测试第二段。', '成员甲：持续发言测试第三段。', '成员乙：持续发言测试第四段。']) {
    await advance(3000);
    assert.equal(calls.length, beforeContinuous, 'no four-second quiet period has occurred yet');
    await addText(text);
  }
  await advance(3000);
  await until(() => calls.length > beforeContinuous, 'continuous speech reaches the maximum wait limit');
  const continuousElapsedMs = await page.evaluate(() => Date.now()) - continuousStart;
  assert(continuousElapsedMs <= 12000, `continuous input waited ${continuousElapsedMs} ms`);
  assert.deepEqual(calls.at(-1).snapshot.new_utterance_ids, ['u3', 'u4', 'u5', 'u6']);
  await completedAt('u6');
  checks.push('Text arriving every three seconds still triggers one batch by the twelve-second maximum wait');

  await addText('主持人：排程尚未触发时停止会话。');
  await advance(1000);
  const beforeStop = calls.length;
  const unsentDraft = '主持人：停止期间保留这条尚未提交的文字。';
  await page.locator('#transcript-input').fill(unsentDraft);
  await page.locator('#stop-session').click();
  await until(async () => await page.locator('#session-state').textContent() === '会话已停止', 'session stopped');
  assert.equal(await page.locator('#auto-analyze').isChecked(), false);
  assert.match(await reason(), /停止|继续/);
  await screenshot('04-stopped');
  await advance(20000);
  assert.equal(calls.length, beforeStop);
  await page.locator('#analysis-next-step').click();
  await until(async () => await page.locator('#session-state').textContent() === '会话进行中', 'next step resumes stopped session');
  assert.equal(await page.locator('#transcript-input').inputValue(), unsentDraft);
  assert.equal((await state()).utterances.length, 7, 'continue does not auto-submit the retained input');
  assert.equal(await page.locator('#auto-analyze').isChecked(), false);
  await advance(15000);
  assert.equal(calls.length, beforeStop);
  checks.push('Stop cancels scheduled analysis; continue retains unsent text and requires another explicit auto opt-in');

  // Leave the typed draft unsent: failure/retry must concern only persisted u7.
  failNext = true;
  await page.locator('#auto-analyze').check();
  await advance(4500);
  await until(async () => calls.length === beforeStop + 1 && !(await page.locator('#auto-analyze').isChecked()), 'failure turns off automatic analysis');
  assert.equal(calls.at(-1).failed, true);
  assert.equal(await page.locator('#analysis-error').isHidden(), false);
  assert.match(await page.locator('#analysis-status').textContent(), /自动.*(?:关闭|暂停|停止)|(?:关闭|暂停|停止).*自动/);
  await screenshot('05-auto-paused-after-error');
  await advance(30000);
  assert.equal(calls.length, beforeStop + 1, 'a failed automatic request must not loop');
  await page.locator('#auto-analyze').check();
  await advance(4500);
  await completedAt('u7');
  assert.equal(calls.length, beforeStop + 2);
  assert.equal(calls.at(-1).failed, false);
  assert.deepEqual(calls.at(-1).snapshot.new_utterance_ids, ['u7']);
  assert.equal(await page.locator('#transcript-input').inputValue(), unsentDraft);
  assert.equal(await page.locator('#analysis-error').isHidden(), true);
  checks.push('Failure pauses auto-analysis without repeated requests; re-enabling explicitly retries the same unprocessed input');
  await screenshot('06-retry-completed');
  assert.deepEqual(errors, []);
  checks.push('No uncaught browser errors; all analyzer responses are synthetic and no audio or real provider was used');
  const report = {
    appVersion: APP_VERSION, source: 'isolated_analysis_controls_browser_test',
    analyzer: 'injected_test_double', realProviderCalls: 0, physicalCapture: false,
    browserClock: 'Playwright installed clock; timing assertions use a controlled clock',
    continuousElapsedMs, analyzerCalls: calls.length, passed: checks.length, checks, errors
  };
  await writeFile(path.join(out, 'analysis-controls-browser-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => { if (!server.listening) return resolve(); server.closeAllConnections(); server.close(resolve); });
}
