// Local UI integration check. No .env access and no provider call.
// The injected analyzer below is a test double, never a production fallback.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createApp } from "../server.mjs";
import { APP_VERSION } from "../version.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/chikitwong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-output");
await mkdir(out, { recursive: true });
const checks = [], errors = [], calls = [];
const designReviewBasis = [
  { run: "cursor__claude-opus-5-5-high__r1", question: "Q7", features: ["F04", "F07", "F08", "F09"], source: "research/assistant_feedback_2026-10-20/raw/cursor__claude-opus-5-5-high__r1/attempt_1/parsed_response.json", interpretation: "Design hypotheses from a model review; not observed participant behavior." },
  { run: "cursor__gemini-4-argon-high__r1", question: "Q7", features: ["F04", "F07", "F08", "F09"], source: "research/assistant_feedback_2026-10-20/raw/cursor__gemini-4-argon-high__r1/attempt_1/parsed_response.json", interpretation: "Design hypotheses from a model review; not observed participant behavior." }
];
const mark = (name) => checks.push(name);
const fixture = async (_config, snapshot) => {
  calls.push(structuredClone(snapshot));
  return {
    summary: "仅供自动化测试：已收到关于到场安排、封面和已完成事项的发言。",
    items: [
      { classification: "action_now", question: "你能在 10:20 到场吗？（测试响应）", reason: "需要本人核对自己的时间，讨论尚未确认。", source_ids: [snapshot.new_utterance_ids[0]], draft: "我需要先核对自己的安排。", deadline: "现在确认", uncertainty: "到场时间需要本人确认。" },
      { classification: "defer", question: "方便时看一下封面。（测试响应）", reason: "发言允许稍后反馈。", source_ids: [snapshot.new_utterance_ids.at(-1)], draft: "我晚些查看。", deadline: null, uncertainty: "" },
      { classification: "awareness", question: "桌卡已准备好。（测试响应）", reason: "只是进度信息，没有要求本人处理。", source_ids: [snapshot.new_utterance_ids.at(-1)], draft: "", deadline: null, uncertainty: "" }
    ]
  };
};
const server = createApp({ apiKey: "test-only", model: "test-double" }, fixture);
const noKey = createApp({ apiKey: "", model: "test-no-key" }, () => { throw new Error("No-key server must not invoke analyzer"); });
const listen = async (srv) => { await new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(0, "127.0.0.1", resolve); }); return `http://127.0.0.1:${srv.address().port}`; };
let browser;
try {
  const url = await listen(server), noKeyUrl = await listen(noKey);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(noKeyUrl);
  await page.waitForFunction(() => document.querySelector("#session-state").textContent === "会话未开始");
  await page.locator("#start-session").click();
  await page.waitForFunction(() => document.querySelector("#monitor-analysis").textContent.includes("未配置 API"));
  assert.match(await page.locator("#monitor-input").textContent(), /人工输入.*未采集声音/);
  assert.match(await page.locator("#monitor-recent").textContent(), /尚未收到任何发言/);
  await page.locator("#transcript-input").fill("主持人：这是未配置密钥的本机测试。");
  await page.locator("#add-transcript").click();
  await page.waitForFunction(() => document.querySelector("#transcript-count").textContent === "1 条");
  assert(await page.locator("#analyze-button").isDisabled());
  assert(await page.locator("#auto-analyze").isDisabled());
  assert.match(await page.locator("#analysis-status").textContent(), /尚未配置/);
  assert.match(await page.locator("#monitor-recent").textContent(), /u1.*人工输入/);
  mark("Missing key disables analysis; text can still be entered");
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#connection-state").textContent.includes("已连接"));
  await page.locator("#start-session").click();
  await page.waitForFunction(() => document.querySelector("#session-state").textContent === "会话进行中");
  assert.equal(await page.locator("#auto-analyze").isChecked(), false);
  assert.match(await page.locator("#monitor-analysis").textContent(), /关闭.*手动分析/);
  await page.locator("#catchup-button").click();
  assert.match(await page.locator("#catchup-list").textContent(), /没有新记录/);
  await page.locator("#done-catchup").click();
  mark("Auto analysis defaults off; empty catchup is accurate");
  await page.locator("#replay-tab").click();
  await page.locator("#load-replay").click();
  await page.waitForFunction(() => document.querySelector("#user-name").value === "数据负责人");
  assert.match(await page.locator("#user-context").inputValue(), /10:25/);
  let state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.utterances.length, 0);
  mark("Rehearsal selects partial-participation role and loading sends no future transcript");
  await page.locator("#start-replay").click();
  await page.waitForFunction(() => document.querySelector("#transcript-count").textContent === "1 条");
  await page.locator("#stop-replay").click();
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.utterances.length, 1);
  assert.equal(state.utterances[0].source, "rehearsal");
  assert.match(await page.locator("#input-mode").textContent(), /演练回放.*暂停/);
  assert.match(await page.locator("#monitor-input").textContent(), /演练回放.*已暂停.*未采集声音/);
  assert.match(await page.locator("#monitor-recent").textContent(), /\d+ 秒前.*演练回放/);
  mark("Timed replay submits only due utterance, then pauses");
  await page.locator("#reset-meeting").click();
  await page.waitForFunction(() => document.querySelector("#transcript-count").textContent === "0 条");
  assert.match(await page.locator("#analysis-status").textContent(), /^新会话已准备好/);
  await page.locator("#start-session").click();
  await page.waitForFunction(() => document.querySelector("#session-state").textContent === "会话进行中");
  await page.locator("#manual-tab").click();
  await page.locator("#transcript-input").fill("主持人：数据负责人，你能在10:20到场吗？\n设计成员：封面今晚再看也可以，桌卡已经打印好了。");
  await page.locator("#add-transcript").click();
  await page.waitForFunction(() => document.querySelector("#transcript-count").textContent === "2 条");
  await page.locator("#analyze-button").click();
  await page.waitForSelector(".alert-card");
  assert.equal(await page.locator(".alert-card").count(), 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.name, "数据负责人");
  assert.equal(calls[0].utterances.length, 2);
  mark("Manual text, profile and completed transcript reach injected test analyzer");
  await page.screenshot({ path: path.join(out, "01-overview-test-double.png"), fullPage: true });
  await page.locator(".alert-card button").first().click();
  assert.match(await page.locator("#dialog-sources").textContent(), /u1.*10:20/s);
  await page.locator("#reply-draft").fill("我到 10:25 才结束另一项安排，预计 10:30 才能到。");
  await page.waitForTimeout(2300);
  assert.equal(await page.locator("#reply-draft").inputValue(), "我到 10:25 才结束另一项安排，预计 10:30 才能到。");
  mark("Source quote is shown; manual draft survives background polling");
  await page.locator("#copy-reply").click();
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.startsWith("已复制"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "我到 10:25 才结束另一项安排，预计 10:30 才能到。");
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.alerts[0].status, "confirmed");
  assert(state.alerts[0].copiedAt);
  await page.locator("#close-alert-dialog").click();
  assert.match(await page.locator(".alert-card-header").first().textContent(), /已复制，待本人发送或记录/);
  await page.screenshot({ path: path.join(out, "05-copied-waiting-test-double.png"), fullPage: true });
  await page.locator(".alert-card button").first().click();
  assert.match(await page.locator("#dialog-state").textContent(), /已复制，待本人发送或记录/);
  await page.locator("#reply-draft").fill("我到 10:25 才结束另一项安排，预计 10:30 才能到。新补充尚未复制。");
  assert.match(await page.locator("#draft-origin").textContent(), /先前版本已复制.*当前编辑稿尚未确认或复制/);
  assert(await page.locator("#mark-sent").isDisabled());
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "我到 10:25 才结束另一项安排，预计 10:30 才能到。");
  await page.screenshot({ path: path.join(out, "06-edited-after-copy-test-double.png"), fullPage: true });
  await page.locator("#close-alert-dialog").click();
  await page.locator(".alert-card button").first().click();
  assert.match(await page.locator("#reply-draft").inputValue(), /新补充尚未复制/);
  assert.match(await page.locator("#dialog-state").textContent(), /上版已复制.*重新确认/);
  await page.locator("#reply-draft").fill("我到 10:25 才结束另一项安排，预计 10:30 才能到。");
  assert.equal(await page.locator("#mark-sent").isDisabled(), false);
  mark("Copied status persists on card and reopened detail; edited text is explicitly unconfirmed and not treated as copied");
  await page.locator("#mark-sent").click();
  await page.waitForFunction(() => document.querySelector("#dialog-state").textContent.includes("已人工记录发送"));
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.alerts[0].deliveryEvidence, "self_reported_manual_send");
  mark("Clipboard succeeds before copy log; manual send is a separate self-reported action");
  await page.locator("#close-alert-dialog").click();
  await page.locator(".alert-card button").nth(1).click();
  await page.locator("#not-needed-reason").selectOption("not_my_role");
  await page.locator("#mark-not-needed").click();
  await page.waitForFunction(() => document.querySelector("#dialog-state").textContent.includes("无需回应"));
  await page.locator("#restore-alert").click();
  await page.waitForFunction(() => document.querySelector("#dialog-state").textContent.includes("待判断"));
  await page.locator("#snooze-alert").click();
  await page.waitForFunction(() => document.querySelector("#dialog-state").textContent.includes("稍后处理"));
  await page.locator("#restore-alert").click();
  await page.waitForFunction(() => document.querySelector("#dialog-state").textContent.includes("待判断"));
  mark("No-response reason and deferred status can be explicitly restored");
  await page.screenshot({ path: path.join(out, "02-detail-test-double.png"), fullPage: true });
  await page.locator("#close-alert-dialog").click();
  await page.locator("#catchup-button").click();
  assert.equal(await page.locator("#catchup-list .transcript-item").count(), 2);
  await page.locator("#refresh-catchup").click();
  await page.locator("#done-catchup").click();
  mark("60-second catchup shows actual received text and supports manual refresh");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#export-log").click();
  const download = await downloadEvent;
  const exportFile = path.join(out, "browser-export-test-double.json");
  await download.saveAs(exportFile);
  const exported = JSON.parse(await readFile(exportFile, "utf8"));
  assert(Array.isArray(exported.browserEvents));
  assert(exported.browserEvents.some((e) => e.type === "catchup_refresh"));
  mark("Download includes server session and local interaction log");
  // Failure case: a blocked clipboard must not create an alert_copy entry.
  await page.locator(".alert-card button").nth(1).click();
  await page.locator("#reply-draft").fill("复制失败测试，不应记录已复制。");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new DOMException("Clipboard blocked in test", "NotAllowedError"); } } }); });
  await page.locator("#copy-reply").click();
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.includes("未记录复制成功"));
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.alerts[1].status, "confirmed");
  assert.equal(state.alerts[1].copiedAt, null);
  mark("Blocked clipboard leaves confirmed draft but records no successful copy");
  await page.locator("#close-alert-dialog").click();
  await page.locator("#auto-analyze").check();
  assert.match(await page.locator("#monitor-analysis").textContent(), /开启.*4 秒/);
  const beforeAuto = calls.length;
  await page.locator("#transcript-input").fill("主持人：我们刚才确认了什么？");
  await page.locator("#add-transcript").click();
  await page.waitForTimeout(1500);
  assert.equal(calls.length, beforeAuto);
  await page.locator("#transcript-input").fill("开发成员：补充说明，这个问题可稍后再处理。");
  await page.locator("#add-transcript").click();
  await page.waitForTimeout(2800);
  assert.equal(calls.length, beforeAuto);
  await page.waitForFunction(() => document.querySelector("#summary-time").textContent.includes("u4"), null, { timeout: 10000 });
  assert.equal(calls.length, beforeAuto + 1);
  await page.waitForTimeout(4500);
  assert.equal(calls.length, beforeAuto + 1);
  mark("Automatic analysis waits 4 seconds after newest text; unchanged text is not analyzed repeatedly");
  await page.locator("#auto-analyze").uncheck();
  assert.match(await page.locator("#monitor-analysis").textContent(), /关闭/);
  // A changed role/background invalidates old pending suggestions, preserving
  // manually edited historical text while requiring a fresh analysis.
  state = await (await fetch(`${url}/api/state`)).json();
  const historicalAlert = state.alerts.find((alert) => alert.status === "pending" && !alert.outdated && alert.classification === "action_now");
  assert(historicalAlert);
  const originalIds = new Set(state.alerts.map((alert) => alert.id));
  const historicalDraft = "我尚未确认借用电脑的兼容性，请先保留这个限制。";
  await page.locator(`[data-alert-id="${historicalAlert.id}"] button`).click();
  await page.locator("#reply-draft").fill(historicalDraft);
  await page.locator("#close-alert-dialog").click();
  await page.locator(".context-settings summary").click();
  const changedFacts = `${await page.locator("#user-context").inputValue()}\n新增事实：借用电脑的兼容性仍未确认，不得承诺可用。`;
  await page.locator("#user-context").fill(changedFacts);
  await page.waitForFunction(() => document.querySelector("#role-save-state").textContent.startsWith("已保存"));
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.profile.privateFacts, changedFacts);
  assert.equal(state.alerts.find((alert) => alert.id === historicalAlert.id).outdated, true);
  assert.equal(state.analysisState.lastAnalyzedUtteranceId, null);
  await page.locator(`[data-alert-id="${historicalAlert.id}"] button`).click();
  assert.match(await page.locator("#dialog-state").textContent(), /历史|仅供回看|旧/);
  assert(await page.locator("#copy-reply").isDisabled());
  assert(await page.locator("#mark-sent").isDisabled());
  assert.equal(await page.locator("#reply-draft").evaluate((node) => node.readOnly), true);
  assert.equal(await page.locator("#reply-draft").inputValue(), historicalDraft);
  await page.screenshot({ path: path.join(out, "04-outdated-background-test-double.png"), fullPage: true });
  await page.locator("#close-alert-dialog").click();
  const beforeProfileAnalysis = calls.length;
  await page.locator("#analyze-button").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status").textContent.startsWith("分析已更新"));
  assert.equal(calls.length, beforeProfileAnalysis + 1);
  assert.equal(calls.at(-1).profile.privateFacts, changedFacts);
  state = await (await fetch(`${url}/api/state`)).json();
  const freshAlert = state.alerts.find((alert) => !originalIds.has(alert.id) && !alert.outdated && alert.status === "pending");
  assert(freshAlert);
  await page.locator(`[data-alert-id="${freshAlert.id}"] button`).click();
  assert.equal(await page.locator("#reply-draft").evaluate((node) => node.readOnly), false);
  assert.equal(await page.locator("#copy-reply").isDisabled(), false);
  await page.locator("#reply-draft").fill("我会先核对兼容性，再给出明确回复。");
  await page.evaluate(() => { delete navigator.clipboard; });
  await page.locator("#copy-reply").click();
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.startsWith("已复制"));
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.alerts.find((alert) => alert.id === freshAlert.id).status, "confirmed");
  await page.locator("#close-alert-dialog").click();
  await page.locator(`[data-alert-id="${historicalAlert.id}"] button`).click();
  assert.equal(await page.locator("#reply-draft").inputValue(), historicalDraft);
  assert(await page.locator("#copy-reply").isDisabled());
  await page.locator("#close-alert-dialog").click();
  mark("Changed background makes pending cards read-only; fresh analysis is actionable and preserves old manual drafts");
  await page.setViewportSize({ width: 680, height: 960 });
  await page.screenshot({ path: path.join(out, "03-narrow-test-double.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  mark("Narrow companion layout has no horizontal page overflow");
  // Synthetic recognition only for isolating the asynchronous microphone queue.
  // This checks queue behavior, not physical microphone or speech-service quality.
  const isolationPage = await context.newPage();
  isolationPage.on("pageerror", (error) => errors.push(error.message));
  isolationPage.on("dialog", (dialog) => dialog.accept());
  await isolationPage.addInitScript(() => {
    window.SpeechRecognition = class {
      constructor() { window.__testRecognition = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
    };
  });
  await isolationPage.goto(url);
  await isolationPage.waitForFunction(() => document.querySelector("#connection-state").textContent.includes("已连接"));
  await isolationPage.locator("#microphone-tab").click();
  assert.match(await isolationPage.locator("#monitor-input").textContent(), /未采集/);
  await isolationPage.evaluate(() => window.dispatchEvent(new CustomEvent("meeting-system-audio-starting")));
  assert.match(await isolationPage.locator("#monitor-input").textContent(), /等待权限或语音服务启动/);
  assert.doesNotMatch(await isolationPage.locator("#monitor-input").textContent(), /采集中/);
  await isolationPage.evaluate(() => window.dispatchEvent(new CustomEvent("meeting-audio-mode", { detail: { active: false } })));
  assert.match(await isolationPage.locator("#monitor-input").textContent(), /未采集/);
  await isolationPage.locator("#start-speech").click();
  assert.match(await isolationPage.locator("#monitor-input").textContent(), /本机麦克风.*采集中/);
  let releaseOldRequest;
  let sawOldRequest;
  const oldRequestReached = new Promise((resolve) => { sawOldRequest = resolve; });
  const releaseGate = new Promise((resolve) => { releaseOldRequest = resolve; });
  await isolationPage.route("**/api/utterances", async (route) => {
    sawOldRequest();
    await releaseGate;
    await route.continue();
  });
  await isolationPage.evaluate(() => {
    for (const text of ["旧会议中正在发送的一句话。", "旧会议中排队等待的一句话。"]) {
      const result = [{ transcript: text }]; result.isFinal = true;
      window.__testRecognition.onresult({ resultIndex: 0, results: [result] });
    }
  });
  await oldRequestReached;
  await isolationPage.locator("#reset-meeting").click();
  await isolationPage.waitForFunction(() => document.querySelector("#transcript-count").textContent === "0 条");
  releaseOldRequest();
  await isolationPage.waitForTimeout(700);
  state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.utterances.length, 0);
  assert.equal(await isolationPage.locator("#transcript-count").textContent(), "0 条");
  assert.match(await isolationPage.locator("#analysis-status").textContent(), /^新会话已准备好/);
  assert.equal(state.session.status, "idle");
  assert.match(await isolationPage.locator("#monitor-input").textContent(), /未采集/);
  assert.match(await isolationPage.locator("#monitor-recent").textContent(), /尚未收到任何发言/);
  mark("Persistent monitor separates selected input, capture/pending/stopped state, transcript recency, and automatic analysis/key availability");
  mark("Reset rejects an old in-flight microphone request and discards its queued successor");
  await isolationPage.close();
  assert.deepEqual(errors, []);
  mark("No uncaught browser errors");
  await writeFile(path.join(out, "browser-check.json"), JSON.stringify({ source: "local_browser_test", appVersion: APP_VERSION, analyzer: "injected_test_double_no_provider_calls", designReviewBasis, passed: checks.length, checks, errors }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
} finally {
  if (browser) await browser.close();
  await Promise.all([server, noKey].map((srv) => new Promise((resolve) => { if (!srv.listening) return resolve(); srv.closeAllConnections(); srv.close(resolve); })));
}
