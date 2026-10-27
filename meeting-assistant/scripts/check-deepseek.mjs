// Manual smoke check: makes ONE billable provider request using fictional input.
// Never included in npm test; never writes configuration, headers, or credentials.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { analyzeWithDeepSeek } from '../deepseek.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'test-output', 'live-deepseek-latest.json');
const profile = {
  name: '小林', role: '课程项目成员', responsibilities: '确认自己能参加排练的时间',
  privateFacts: '周四14:00之前有课，只能14:00之后参加。'
};
const utterance = { speaker: '主持人', text: '小林，我们现在要确定周四排练时间，你13:30能到吗？请现在确认。', source: 'rehearsal' };
const report = { checkedAt: new Date().toISOString(), inputType: 'fictional_smoke_test', input: { profile, utterance }, providerRequests: 0, providerHttpStatuses: [] };
let server;
try {
  const envFile = path.join(project, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('KEY_MISSING');
  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('INVALID_TIMEOUT');
  report.configuredModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  server = createApp({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: report.configuredModel, timeoutMs,
    feedbackDirectory: path.join(project, 'test-output', 'smoke-unused-feedback')
  }, (config, snapshot, options) => analyzeWithDeepSeek(config, snapshot, options, async (...args) => {
    report.providerRequests++;
    const response = await fetch(...args);
    report.providerHttpStatuses.push(response.status);
    return response;
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let state;
  async function post(route, body = {}) {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ ...(state ? { meetingId: state.meetingId, sessionGeneration: state.session.generation } : {}), ...body }),
      signal: AbortSignal.timeout(timeoutMs + 10000)
    });
    const result = await response.json();
    if (!response.ok) {
      report.error = { httpStatus: response.status, code: result.code, message: result.error };
      throw new Error('APP_REQUEST_FAILED');
    }
    state = result;
  }
  await post('/api/session/start');
  await post('/api/profile', profile);
  await post('/api/utterances', utterance);
  const started = performance.now();
  await post('/api/analyze');
  report.analysisElapsedMs = Math.round(performance.now() - started);
  report.summary = state.summary;
  report.alerts = state.alerts.map(({ classification, question, reason, source_ids, draft, deadline, uncertainty }) => ({ classification, question, reason, source_ids, draft, deadline, uncertainty }));
  report.analysisState = state.analysisState;
  const exported = await fetch(`${origin}/api/export`).then(response => response.json());
  report.analysisCompletedRecorded = exported.events.some(event => event.type === 'analysis_completed');
  report.success = report.providerRequests === 1 && report.providerHttpStatuses[0] === 200 &&
    state.analysisState.lastAnalyzedUtteranceId === state.utterances.at(-1).id &&
    state.analysisState.running === false && state.analysisState.lastError === null && report.analysisCompletedRecorded;
  if (!report.success) process.exitCode = 1;
} catch (error) {
  report.success = false;
  if (!report.error) report.error = { code: ['KEY_MISSING', 'INVALID_TIMEOUT'].includes(error.message) ? error.message : 'SMOKE_CHECK_FAILED' };
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
