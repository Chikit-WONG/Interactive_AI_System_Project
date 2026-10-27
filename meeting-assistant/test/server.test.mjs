import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { analyzeWithDeepSeek, validateAnalysis, buildSystemPrompt } from '../deepseek.mjs';

async function fixture(t, options = {}, analyzer) {
  const server = createApp(options, analyzer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, body, extra = {}) => {
    const response = await fetch(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  return { api, origin };
}

const profile = { name: '小林', role: '数据负责人', responsibilities: '确认排练时间与笔记本接口', privateFacts: '周四14点前有课', language: 'zh' };
const analysis = snapshot => ({
  summary: '等待小林确认排练时间。',
  items: [{ classification: 'action_now', question: '周四13:30能参加吗？', reason: '准备确定时间，需要本人确认。',
    source_ids: [snapshot.new_utterance_ids[0]], draft: '我需要确认时间。', deadline: null, uncertainty: '' }]
});

test('English is the default and rehearsal can be selected in either language', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('/api/state')).body.profile.language, 'en');
  const english = (await api('/api/rehearsal')).body;
  assert.equal(english.roles[1].name, 'Alex');
  assert.equal(/\p{Script=Han}/u.test(JSON.stringify(english)), false);
  const chinese = (await api('/api/rehearsal?lang=zh')).body;
  assert.equal(chinese.roles[1].name, '数据负责人');
  assert.equal((await api('/api/profile', { ...profile, language: 'fr' })).body.code, 'INVALID_LANGUAGE');
  const stopped = await api('/api/analyze', {});
  assert.match(stopped.body.error, /Start or resume/);
});

test('language changes preserve utterances, source IDs, confirmed replies and processed progress', async t => {
  const snapshots = [];
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_config, snapshot) => {
    snapshots.push(snapshot); return analysis(snapshot);
  });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  const text = '小林，请核对这个原文。 Keep this quoted text exactly.';
  await api('/api/utterances', { speaker: '主持人', text, source: 'browser_mixed' });
  const id = (await api('/api/analyze', {})).body.alerts[0].id;
  const before = (await api(`/api/alerts/${id}/action`, { action: 'confirm', text: '本人编辑：14:00以后。' })).body;
  const after = (await api('/api/profile', { ...profile, language: 'en' })).body;
  assert.deepEqual(after.alerts, before.alerts);
  assert.deepEqual(after.utterances, before.utterances);
  assert.deepEqual(after.analysisState, before.analysisState);
  assert.equal(after.summary, before.summary);
  assert.deepEqual(after.session, before.session);
  await api('/api/analyze', {});
  assert.equal(snapshots.length, 1, 'changing language alone does not repeat paid analysis');
  await api('/api/utterances', { speaker: 'Jordan', text: 'Alex, can you confirm now?', source: 'manual' });
  await api('/api/analyze', {});
  assert.equal(snapshots[1].profile.language, 'en');
  assert.equal(snapshots[1].utterances[0].text, text);
  assert.deepEqual(snapshots[1].new_utterance_ids, ['u2']);
  assert.equal(snapshots[1].existing_alerts[0].confirmedText, '');
  assert.equal(snapshots[1].existing_alerts[0].delivery_status, 'not_sent');
  assert.equal((await api('/api/state')).body.alerts[0].confirmedText, '本人编辑：14:00以后。');
  assert.equal((await api('/api/reset', {})).body.profile.language, 'en');
});

test('output language is a system-level instruction while original quotes and IDs stay intact', async () => {
  const english = buildSystemPrompt();
  assert.match(english, /Write summary, question, reason, draft and uncertainty in English/);
  assert.doesNotMatch(english, /输出中文json/);
  assert.match(buildSystemPrompt('zh'), /in Simplified Chinese/);
  assert.match(english, /Preserve source_ids verbatim/);
  assert.match(english, /preserve its original wording and language/);
  const snapshot = { profile: { ...profile, language: 'en' }, utterances: [{ id: 'u1', speaker: '主持人', text: '10:40可以吗？' }], new_utterance_ids: ['u1'], existing_alerts: [] };
  await analyzeWithDeepSeek({ apiKey: 'test-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 }, snapshot, async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.equal(messages[0].content, english);
    assert.deepEqual(JSON.parse(messages[1].content), snapshot);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis(snapshot)) } }] }));
  });
});

test('missing key fails clearly; no fake model response is generated', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('/api/status')).body.keyConfigured, false);
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '请确认时间。', source: 'manual' });
  assert.equal((await api('/api/analyze', {})).status, 503);
  assert.equal((await api('/api/state')).body.alerts.length, 0);
});

test('confirmation, copy, and self-reported delivery are separate; no key is exported', async t => {
  const seen = [];
  const { api } = await fixture(t, { apiKey: 'test-secret-only' }, async (_config, snapshot) => {
    seen.push(snapshot); return analysis(snapshot);
  });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '周四13:30能参加吗？', source: 'rehearsal' });
  const result = await api('/api/analyze', {});
  assert.equal(result.status, 200);
  assert.equal(seen[0].utterances.length, 1);
  assert.equal(seen[0].new_utterance_ids[0], 'u1');
  const id = result.body.alerts[0].id;
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'mark_sent' })).status, 409);
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'confirm', text: '我14点之后才有空。' })).body.alerts[0].status, 'confirmed');
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'copy' })).body.alerts[0].status, 'confirmed');
  const delivered = await api(`/api/alerts/${id}/action`, { action: 'mark_sent' });
  assert.equal(delivered.body.alerts[0].deliveryEvidence, 'self_reported_manual_send');
  assert.equal(delivered.body.alerts[0].status, 'sent');
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'not_needed', reason: '无关' })).status, 409);
  await api('/api/analyze', {});
  assert.equal(seen.length, 1, 'unchanged input does not spend another request');
  const exported = (await api('/api/export')).body;
  assert.deepEqual(exported.inputSourceTypes, ['rehearsal']);
  assert.equal(exported.responseValidity, 'not_evaluated');
  assert.ok(!JSON.stringify(exported).includes('test-secret-only'));
});

test('not-needed can be restored without inventing a sent response', async t => {
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_c, s) => analysis(s));
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '成员', text: '有空帮忙看一下封面。', source: 'manual' });
  const id = (await api('/api/analyze', {})).body.alerts[0].id;
  const closed = await api(`/api/alerts/${id}/action`, { action: 'not_needed', reason: '不属于我的职责' });
  assert.equal(closed.body.alerts[0].status, 'not_needed');
  assert.equal(closed.body.alerts[0].confirmedText, '');
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'restore' })).body.alerts[0].status, 'pending');
});

test('changing profile during analysis discards stale output', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_c, s) => { await wait; return analysis(s); });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '请确认。', source: 'manual' });
  const running = api('/api/analyze', {});
  for (let i = 0; i < 50; i++) {
    if ((await api('/api/state')).body.analysisState.running) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await api('/api/profile', { ...profile, name: '另一人' });
  release();
  assert.equal((await running).status, 409);
  assert.equal((await api('/api/state')).body.alerts.length, 0);
});

test('saving an unchanged profile keeps analysis and does not spend another request', async t => {
  let calls = 0;
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_c, s) => {
    calls++;
    return analysis(s);
  });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '请确认时间。', source: 'manual' });
  const before = (await api('/api/analyze', {})).body;
  const saved = (await api('/api/profile', { ...profile, name: ` ${profile.name} ` })).body;
  assert.deepEqual(saved, before, 'normalized identical fields do not invalidate existing state');
  await api('/api/analyze', {});
  assert.equal(calls, 1);
});

test('changed facts invalidate unsent replies and allow a fresh card for the same question', async t => {
  const snapshots = [];
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_c, snapshot) => {
    snapshots.push(snapshot);
    const result = analysis(snapshot);
    result.items[0].draft = snapshot.profile.privateFacts;
    return result;
  });
  await api('/api/session/start', {});
  await api('/api/profile', { ...profile, privateFacts: '已收到7份问卷' });
  await api('/api/utterances', { speaker: '主持人', text: '收到了多少份问卷？', source: 'manual' });
  const first = (await api('/api/analyze', {})).body.alerts[0];
  await api(`/api/alerts/${first.id}/action`, { action: 'confirm', text: '人工核对：7份。' });
  await api(`/api/alerts/${first.id}/action`, { action: 'copy' });
  const previous = (await api('/api/state')).body.alerts[0];
  const changed = (await api('/api/profile', { ...profile, privateFacts: '已收到12份问卷' })).body;
  assert.equal(changed.summary, '');
  assert.equal(changed.analysisState.lastAnalyzedUtteranceId, null);
  const old = changed.alerts[0];
  assert.equal(old.outdated, true);
  assert.ok(old.outdatedAt);
  assert.equal(old.status, 'confirmed');
  assert.equal(old.confirmedText, previous.confirmedText);
  assert.equal(old.confirmedAt, previous.confirmedAt);
  assert.equal(old.copiedAt, previous.copiedAt);
  for (const action of ['confirm', 'copy', 'mark_sent', 'not_needed', 'restore', 'defer']) {
    const blocked = await api(`/api/alerts/${first.id}/action`, { action, text: '12份', reason: '背景已变' });
    assert.equal(blocked.status, 409, action);
    assert.equal(blocked.body.code, 'OUTDATED_ALERT', action);
  }
  const refreshed = (await api('/api/analyze', {})).body;
  assert.deepEqual(snapshots[1].existing_alerts, []);
  assert.equal(refreshed.alerts.length, 2);
  assert.deepEqual(refreshed.alerts[0], old, 'stale manual work stays intact');
  assert.equal(refreshed.alerts[1].draft, '已收到12份问卷');
  assert.equal(refreshed.alerts[1].outdated, false);
  assert.equal(refreshed.alerts[1].status, 'pending');
  assert.notEqual(refreshed.alerts[1].id, old.id);
});

test('profile changes preserve sent history while invalidating every unsent status', async t => {
  const snapshots = [];
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_c, snapshot) => {
    snapshots.push(snapshot);
    const result = analysis(snapshot);
    result.items = ['sent', 'pending', 'deferred', 'not_needed'].map(question => ({
      ...result.items[0], question
    }));
    return result;
  });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '请确认各项。', source: 'manual' });
  const first = (await api('/api/analyze', {})).body.alerts;
  await api(`/api/alerts/${first[0].id}/action`, { action: 'confirm', text: '本人已核对。' });
  await api(`/api/alerts/${first[0].id}/action`, { action: 'mark_sent' });
  await api(`/api/alerts/${first[2].id}/action`, { action: 'defer' });
  await api(`/api/alerts/${first[3].id}/action`, { action: 'not_needed', reason: '已有人处理' });
  const previous = (await api('/api/state')).body.alerts;
  const changed = (await api('/api/profile', { ...profile, responsibilities: '只确认排练时间' })).body;
  assert.deepEqual(changed.alerts[0], previous[0], 'sent history is not rewritten or invalidated');
  for (let i = 1; i < previous.length; i++) {
    assert.equal(changed.alerts[i].outdated, true);
    assert.equal(changed.alerts[i].status, previous[i].status);
    assert.equal(changed.alerts[i].notNeededReason, previous[i].notNeededReason);
  }
  const refreshed = (await api('/api/analyze', {})).body;
  assert.deepEqual(snapshots[1].existing_alerts.map(a => a.question), ['sent']);
  assert.equal(refreshed.alerts.filter(a => a.question === 'sent').length, 1);
  assert.deepEqual(refreshed.alerts[0], previous[0]);
});

test('local server rejects foreign origins and does not serve config files', async t => {
  const { api, origin } = await fixture(t, { apiKey: 'test-only' });
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.appId, 'partial-participation-meeting-assistant');
  assert.match(health.body.installationId, /^[a-f0-9]{24}$/);
  assert.equal(health.body.pid, process.pid);
  assert.equal(JSON.stringify(health.body).includes('test-only'), false);
  assert.equal((await fetch(`${origin}/api/health`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await api('/api/utterances', {}, { Origin: 'https://attacker.example' })).status, 403);
  // fetch may normalize Host; use the HTTP transport to exercise DNS-rebinding protection.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/state`, { headers: { Host: 'attacker.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const url of ['/.env', '/server.mjs', '/%2e%2e%2f.env', '/rehearsal/script.json']) {
    assert.equal((await fetch(`${origin}${url}`)).status, 404);
  }
  const invalid = await fetch(`${origin}/api/profile`, { method: 'POST', body: '{}' });
  assert.equal(invalid.status, 415);
});

test('old microphone or replay submissions cannot enter a new meeting', async t => {
  const { api } = await fixture(t);
  const previousId = (await api('/api/state')).body.meetingId;
  await api('/api/reset', {});
  const result = await api('/api/utterances', {
    meetingId: previousId, speaker: '上一场成员', text: '迟到的语音识别结果', source: 'browser_mic'
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STALE_SESSION');
  assert.equal((await api('/api/state')).body.utterances.length, 0);
});

test('session clock starts explicitly, excludes pauses, resumes records, and resets to idle', async t => {
  let elapsed = 0;
  const epoch = Date.parse('2026-10-22T08:00:00.000Z');
  const { api } = await fixture(t, { clock: { now: () => epoch + elapsed, monotonic: () => elapsed } });
  const initial = (await api('/api/state')).body;
  assert.deepEqual(initial.session, { status: 'idle', elapsedMs: 0, activeSince: null, generation: 0 });
  assert.equal(initial.startedAt, null);
  elapsed += 9000;
  assert.equal((await api('/api/export')).body.sessionElapsedMsAtExport, 0);
  const input = { speaker: '主持人', text: '请确认时间。', source: 'manual' };
  assert.equal((await api('/api/utterances', input)).body.code, 'SESSION_NOT_RUNNING');
  assert.equal((await api('/api/analyze', {})).body.code, 'SESSION_NOT_RUNNING');
  const started = (await api('/api/session/start', { sessionGeneration: 0 })).body;
  assert.equal(started.meetingId, initial.meetingId);
  assert.equal(started.startedAt, new Date(epoch + elapsed).toISOString());
  assert.equal(started.session.activeSince, started.startedAt);
  assert.equal(started.session.generation, 1);
  assert.deepEqual((await api('/api/session/start', { sessionGeneration: 1 })).body, started, 'repeat start is a no-op');
  await api('/api/profile', profile);
  await api('/api/utterances', { ...input, sessionGeneration: 1 });
  elapsed += 2500;
  assert.equal((await api('/api/state')).body.session.elapsedMs, 0, 'current interval is represented by activeSince');
  const activeExport = (await api('/api/export')).body;
  assert.equal(activeExport.sessionElapsedMsAtExport, 2500);
  assert.equal(activeExport.schemaVersion, 'companion.v0.3');
  assert.equal(activeExport.appVersion, '0.3.0');
  const stopped = (await api('/api/session/stop', { sessionGeneration: 1 })).body;
  assert.deepEqual(stopped.session, { status: 'stopped', elapsedMs: 2500, activeSince: null, generation: 2 });
  elapsed += 15000;
  assert.equal((await api('/api/export')).body.sessionElapsedMsAtExport, 2500);
  assert.deepEqual((await api('/api/session/stop', { sessionGeneration: 2 })).body, stopped, 'repeat stop is a no-op');
  assert.equal((await api('/api/utterances', input)).body.code, 'SESSION_NOT_RUNNING');
  assert.equal((await api('/api/analyze', {})).body.code, 'SESSION_NOT_RUNNING');
  const resumed = (await api('/api/session/start', { sessionGeneration: 2 })).body;
  assert.equal(resumed.meetingId, initial.meetingId);
  assert.equal(resumed.startedAt, started.startedAt);
  assert.equal(resumed.utterances.length, 1);
  assert.equal(resumed.session.generation, 3);
  assert.equal(resumed.session.elapsedMs, 2500);
  for (const route of ['/api/utterances', '/api/analyze', '/api/session/stop']) {
    const stale = await api(route, { ...input, sessionGeneration: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_SESSION_GENERATION');
  }
  assert.equal((await api('/api/state')).body.session.status, 'running');
  elapsed += 1250;
  assert.equal((await api('/api/session/stop', { sessionGeneration: 3 })).body.session.elapsedMs, 3750);
  const reset = (await api('/api/reset', {})).body;
  assert.notEqual(reset.meetingId, initial.meetingId);
  assert.deepEqual(reset.profile, profile);
  assert.deepEqual(reset.session, initial.session);
  assert.equal(reset.startedAt, null);
  assert.equal(reset.utterances.length, 0);
});

test('stop cancels pending analysis immediately and late work cannot overwrite a resumed analysis', async t => {
  const jobs = [];
  const { api } = await fixture(t, { apiKey: 'test-only' }, (_config, snapshot, { signal }) =>
    new Promise(resolve => { jobs.push({ snapshot, signal, resolve }); }));
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '主持人', text: '请确认时间。', source: 'manual', sessionGeneration: 1 });
  const first = api('/api/analyze', { sessionGeneration: 1 });
  for (let i = 0; i < 100 && jobs.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(jobs.length, 1);
  const stopped = await api('/api/session/stop', { sessionGeneration: 1 });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.analysisState.running, false);
  assert.equal(jobs[0].signal.aborted, true);
  const cancelled = await first;
  assert.equal(cancelled.status, 409, 'HTTP request settles without waiting for an uncooperative provider');
  assert.equal(cancelled.body.code, 'STALE_ANALYSIS');
  await api('/api/session/start', { sessionGeneration: 2 });
  const second = api('/api/analyze', { sessionGeneration: 3 });
  for (let i = 0; i < 100 && jobs.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(jobs.length, 2);
  jobs[0].resolve({ ...analysis(jobs[0].snapshot), summary: 'THIS LATE RESULT MUST BE DISCARDED' });
  await new Promise(resolve => setImmediate(resolve));
  const whileRunning = (await api('/api/state')).body;
  assert.equal(whileRunning.analysisState.running, true);
  assert.equal(whileRunning.analysisState.lastError, null);
  assert.equal(whileRunning.alerts.length, 0);
  assert.equal(whileRunning.summary, '');
  assert.equal((await api('/api/analyze', { sessionGeneration: 3 })).body.code, 'BUSY');
  jobs[1].resolve(analysis(jobs[1].snapshot));
  const completed = await second;
  assert.equal(completed.status, 200);
  assert.equal(completed.body.analysisState.running, false);
  assert.equal(completed.body.analysisState.lastAnalyzedUtteranceId, 'u1');
  assert.equal(completed.body.alerts.length, 1);
  await api('/api/session/stop', { sessionGeneration: 3 });
  const id = completed.body.alerts[0].id;
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'confirm', text: '停会后核对的回复。' })).status, 200);
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'copy' })).status, 200);
  assert.equal((await api(`/api/alerts/${id}/action`, { action: 'mark_sent' })).body.alerts[0].status, 'sent');
  const exported = (await api('/api/export')).body;
  assert.equal(exported.events.filter(event => event.type === 'analysis_completed').length, 1);
  assert.equal(exported.events.filter(event => event.type === 'analysis_cancelled').length, 1);
  assert.equal(JSON.stringify(exported).includes('THIS LATE RESULT'), false);
});

test('reset during analysis aborts it and late results cannot enter the new idle meeting', async t => {
  let release, signal;
  const { api } = await fixture(t, { apiKey: 'test-only' }, (_c, snapshot, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = () => resolve(analysis(snapshot)); });
  });
  const previous = (await api('/api/session/start', {})).body;
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: '成员', text: '请确认。', source: 'manual' });
  const pending = api('/api/analyze', {});
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(release);
  const reset = (await api('/api/reset', {})).body;
  assert.notEqual(reset.meetingId, previous.meetingId);
  assert.equal(reset.session.status, 'idle');
  assert.deepEqual(reset.profile, profile);
  assert.equal(signal.aborted, true);
  assert.equal((await pending).body.code, 'STALE_ANALYSIS');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await api('/api/state')).body, reset);
});

test('provider receives cancellation separately from timeout and never exposes abort details', async () => {
  const snapshot = { profile, utterances: [{ id: 'u1' }], new_utterance_ids: ['u1'], existing_alerts: [] };
  const config = { apiKey: 'test-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 };
  const controller = new AbortController();
  let received;
  const pending = analyzeWithDeepSeek(config, snapshot, { signal: controller.signal }, async (_url, options) => {
    received = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  controller.abort(new Error('PRIVATE_ABORT_DETAIL'));
  assert.equal(received.aborted, true);
  await assert.rejects(pending, error => error.code === 'ANALYSIS_CANCELLED' && !error.message.includes('PRIVATE'));
  const bodyAbort = new AbortController();
  await assert.rejects(analyzeWithDeepSeek(config, snapshot, { signal: bodyAbort.signal }, async () => ({
    ok: true,
    json: async () => { bodyAbort.abort(); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis(snapshot)) } }] }; }
  })), { code: 'ANALYSIS_CANCELLED' });
});

test('provider parser validates citations, handles truncation, and hides upstream errors', async () => {
  const snapshot = { profile, utterances: [{ id: 'u1', speaker: '主持人', text: '请确认。' }], new_utterance_ids: ['u1'], existing_alerts: [] };
  const config = { apiKey: 'test-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 };
  const fetchGood = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(JSON.parse(options.body).response_format.type, 'json_object');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis(snapshot)) } }] }));
  };
  assert.equal((await analyzeWithDeepSeek(config, snapshot, fetchGood)).items.length, 1);
  const invalid = analysis(snapshot);
  invalid.items[0].source_ids = ['future-u99'];
  assert.throws(() => validateAnalysis(invalid, snapshot.utterances, snapshot.new_utterance_ids), { code: 'INVALID_SOURCES' });
  await assert.rejects(analyzeWithDeepSeek(config, snapshot, async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))), { code: 'INVALID_MODEL_OUTPUT' });
  await assert.rejects(analyzeWithDeepSeek(config, snapshot, async () =>
    new Response('secret-provider-body', { status: 401 })), error => error.code === 'PROVIDER_REJECTED' && !error.message.includes('secret'));
  await assert.rejects(analyzeWithDeepSeek({ ...config, baseUrl: 'https://other.example' }, snapshot, fetchGood), { code: 'INVALID_BASE_URL' });
});


test('unsent confirmations stay local; later analysis receives only self-reported sent reply text', async t => {
  const snapshots = [];
  const { api } = await fixture(t, { apiKey: 'test-only' }, async (_config, snapshot) => {
    snapshots.push(snapshot); return analysis(snapshot);
  });
  await api('/api/session/start', {});
  await api('/api/profile', profile);
  await api('/api/utterances', { speaker: 'Host', text: 'Please confirm now.', source: 'manual' });
  const id = (await api('/api/analyze', {})).body.alerts[0].id;
  await api(`/api/alerts/${id}/action`, { action: 'confirm', text: 'LOCAL_UNSENT_REPLY' });
  await api(`/api/alerts/${id}/action`, { action: 'copy' });
  await api('/api/utterances', { speaker: 'Host', text: 'Are you there?', source: 'manual' });
  await api('/api/analyze', {});
  assert.equal(snapshots.at(-1).existing_alerts[0].delivery_status, 'not_sent');
  assert.equal(JSON.stringify(snapshots.at(-1)).includes('LOCAL_UNSENT_REPLY'), false);
  assert.equal((await api('/api/state')).body.alerts[0].confirmedText, 'LOCAL_UNSENT_REPLY');
  await api(`/api/alerts/${id}/action`, { action: 'mark_sent' });
  await api('/api/utterances', { speaker: 'Host', text: 'One more question.', source: 'manual' });
  await api('/api/analyze', {});
  assert.equal(snapshots.at(-1).existing_alerts[0].delivery_status, 'self_reported_sent');
  assert.equal(snapshots.at(-1).existing_alerts[0].confirmedText, 'LOCAL_UNSENT_REPLY');
});
