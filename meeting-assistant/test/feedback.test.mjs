import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedbackStore } from '../feedback.mjs';
import { createApp } from '../server.mjs';
import { APP_VERSION } from '../version.mjs';

const testOutput = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');

async function temporary(t) {
  await mkdir(testOutput, { recursive: true });
  const directory = await mkdtemp(path.join(testOutput, 'feedback-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), testOutput);
    assert.ok(path.basename(resolved).startsWith('feedback-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function feedback(extra = {}) {
  return {
    submissionId: randomUUID(), usageStage: 'hands_on', topic: 'timing',
    message: '提醒太早，希望先看到提出的问题。', ...extra
  };
}

const privateState = {
  meetingId: 'meeting-one',
  profile: { name: 'PRIVATE_NAME', responsibilities: 'PRIVATE_ROLE', privateFacts: 'PRIVATE_BACKGROUND' },
  utterances: [
    { source: 'manual', speaker: 'PRIVATE_SPEAKER', text: 'PRIVATE_TRANSCRIPT' },
    { source: 'browser_mixed', text: 'PRIVATE_TRANSCRIPT_2' }
  ],
  alerts: [{
    id: 'alert-one', classification: 'action_now', status: 'confirmed', question: 'PRIVATE_QUESTION',
    draft: 'PRIVATE_DRAFT', confirmedText: 'PRIVATE_CONFIRMED_REPLY', reason: 'PRIVATE_REASON'
  }],
  summary: 'PRIVATE_SUMMARY', events: [{ detail: 'PRIVATE_EVENT' }]
};

test('feedback persists across store instances and normalized retries return the original receipt', async t => {
  const directory = path.join(await temporary(t), 'records');
  const store = createFeedbackStore(directory);
  assert.deepEqual(await store.status(), { count: 0 });
  await assert.rejects(access(directory), { code: 'ENOENT' }, 'reads do not create a data directory');
  const request = feedback();
  const first = await store.save(request, privateState);
  assert.equal(first.saved, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.count, 1);
  const restarted = createFeedbackStore(directory);
  assert.deepEqual(await restarted.status(), { count: 1 });
  const duplicate = await restarted.save({ ...request, message: ` ${request.message} ` }, {});
  assert.deepEqual(duplicate, { ...first, duplicate: true });
  await assert.rejects(restarted.save({ ...request, message: '不同的反馈。' }, privateState),
    { status: 409, code: 'FEEDBACK_ID_CONFLICT' });
  const exported = await restarted.export();
  assert.equal(exported.count, 1);
  assert.equal(exported.records[0].message, request.message);
  assert.equal(exported.records[0].sourceType, 'in_app_feedback');
  assert.equal(exported.records[0].verification, 'self_reported');
  assert.equal(exported.appVersion, APP_VERSION);
  assert.equal(exported.records[0].appVersion, APP_VERSION);
  assert.equal(exported.records[0].rating, null);
  assert.equal(exported.records[0].context, null);
  assert.equal('requestHash' in exported.records[0], false);
});

test('feedback versions describe their original build without rewriting legacy records', async t => {
  const directory = path.join(await temporary(t), 'records');
  const store = createFeedbackStore(directory);
  const legacy = feedback(), earlier = feedback(), current = feedback();
  for (const request of [legacy, earlier, current]) await store.save(request);
  const legacyPath = path.join(directory, `${legacy.submissionId}.json`);
  const legacyRecord = JSON.parse(await readFile(legacyPath, 'utf8'));
  delete legacyRecord.appVersion;
  await writeFile(legacyPath, JSON.stringify(legacyRecord), 'utf8');
  const earlierPath = path.join(directory, `${earlier.submissionId}.json`);
  const earlierRecord = JSON.parse(await readFile(earlierPath, 'utf8'));
  earlierRecord.appVersion = '0.1.0';
  await writeFile(earlierPath, JSON.stringify(earlierRecord), 'utf8');
  const restarted = createFeedbackStore(directory);
  assert.equal((await restarted.save(legacy)).duplicate, true, 'legacy retry still resolves its saved record');
  const exported = await restarted.export();
  const versions = new Map(exported.records.map(record => [record.id, record.appVersion]));
  assert.equal(exported.appVersion, APP_VERSION, 'top-level version identifies the exporting build');
  assert.equal(versions.get(legacy.submissionId), 'unknown');
  assert.equal(versions.get(earlier.submissionId), '0.1.0');
  assert.equal(versions.get(current.submissionId), APP_VERSION);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(legacyPath, 'utf8')), 'appVersion'), false);
  assert.equal(JSON.parse(await readFile(path.join(directory, `${current.submissionId}.json`), 'utf8')).appVersion, APP_VERSION);
});

test('concurrent duplicate submissions publish exactly one complete record across stores', async t => {
  const directory = path.join(await temporary(t), 'records');
  const stores = [createFeedbackStore(directory), createFeedbackStore(directory)];
  const request = feedback();
  const receipts = await Promise.all(Array.from({ length: 16 }, (_, i) => stores[i % 2].save(request, privateState)));
  assert.equal(receipts.filter(item => !item.duplicate).length, 1);
  assert.equal(new Set(receipts.map(item => item.createdAt)).size, 1);
  assert.ok(receipts.every(item => item.id === request.submissionId && item.count === 1));
  assert.deepEqual(await readdir(directory), [`${request.submissionId}.json`]);
  assert.equal(JSON.parse(await readFile(path.join(directory, `${request.submissionId}.json`), 'utf8')).message, request.message);
});

test('concurrent conflicting content cannot overwrite the winning submission', async t => {
  const directory = path.join(await temporary(t), 'records');
  const request = feedback();
  const outcomes = await Promise.allSettled([
    createFeedbackStore(directory).save(request),
    createFeedbackStore(directory).save({ ...request, message: '另一个内容' })
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(item => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'FEEDBACK_ID_CONFLICT');
  const winningIndex = outcomes.findIndex(item => item.status === 'fulfilled');
  const values = await createFeedbackStore(directory).export();
  assert.equal(values.count, 1);
  assert.equal(values.records[0].message, winningIndex === 0 ? request.message : '另一个内容');
});

test('only explicitly requested metadata is stored; no background or transcript is attached', async t => {
  const directory = path.join(await temporary(t), 'records');
  const store = createFeedbackStore(directory);
  await store.save(feedback({ alertId: 'alert-one' }), privateState);
  const contextual = feedback({
    includeContext: true, alertId: 'alert-one', meetingId: privateState.meetingId,
    rating: 4, expected: '请给我更多上下文。', participantCode: 'P07'
  });
  const first = await store.save(contextual, privateState);
  const values = await store.export();
  const metadata = values.records.find(item => item.id === contextual.submissionId);
  assert.deepEqual(metadata.context, {
    inputSourceTypes: ['manual', 'browser_mixed'], utteranceCount: 2, alertCount: 1,
    alert: { id: 'alert-one', classification: 'action_now', status: 'confirmed' }
  });
  for (const name of await readdir(directory)) {
    const raw = await readFile(path.join(directory, name), 'utf8');
    assert.equal(raw.includes('PRIVATE_'), false);
    assert.equal(raw.includes('meeting-one'), false, 'the session identifier is not persisted');
  }
  const changedState = { meetingId: 'different-meeting', utterances: [], alerts: [] };
  const duplicate = await store.save(contextual, changedState);
  assert.deepEqual(duplicate, { ...first, duplicate: true }, 'saved retries retain the original context');
  await assert.rejects(store.save({ ...contextual, submissionId: randomUUID() }, changedState),
    { status: 409, code: 'STALE_SESSION' });
  await assert.rejects(store.save(feedback({ includeContext: true, alertId: 'missing' }), privateState),
    { status: 400, code: 'FEEDBACK_ALERT_NOT_FOUND' });
  assert.equal((await store.save(feedback({ meetingId: 'older-meeting' }), changedState)).saved, true);
});

test('feedback validates choices, lengths, scores, booleans, IDs and provenance injection', async t => {
  const directory = path.join(await temporary(t), 'records');
  const store = createFeedbackStore(directory);
  const invalid = [
    { submissionId: '../../outside' }, { usageStage: 'interview_verified' }, { topic: 'unknown' },
    { message: '' }, { message: 'x'.repeat(4001) }, { expected: 'x'.repeat(2001) },
    { participantCode: 'x'.repeat(81) }, { rating: 0 }, { rating: 6 }, { rating: 1.5 },
    { rating: '5' }, { includeContext: 'true' }, { alertId: {} }, { expected: null },
    { sourceType: 'model_simulation' }, { verification: 'verified_interview' },
    { context: privateState }, { createdAt: '2000-01-01' }, { appVersion: 'injected-client-version' }
  ];
  for (const extra of invalid) {
    await assert.rejects(store.save(feedback(extra), privateState), { status: 400, code: 'INVALID_FEEDBACK' });
  }
  assert.deepEqual(await store.status(), { count: 0 });
  for (const usageStage of ['hands_on', 'watched_demo', 'concept_only']) {
    for (const topic of ['timing', 'missed_request', 'context', 'draft', 'input', 'other']) {
      assert.equal((await store.save(feedback({ usageStage, topic, rating: 5 }))).saved, true);
    }
  }
  assert.equal((await store.status()).count, 18);
});

test('unavailable storage and corrupted records report errors rather than false success or empty export', async t => {
  const directory = await temporary(t);
  const blocked = path.join(directory, 'not-a-directory');
  await writeFile(blocked, 'fixture', 'utf8');
  const unavailable = createFeedbackStore(blocked);
  await assert.rejects(unavailable.save(feedback()), { status: 503, code: 'FEEDBACK_STORAGE_ERROR' });
  const corruptId = randomUUID();
  await writeFile(path.join(directory, `${corruptId}.json`), '{"broken":', 'utf8');
  const corrupt = createFeedbackStore(directory);
  await assert.rejects(corrupt.status(), { status: 503, code: 'FEEDBACK_STORAGE_ERROR' });
  await assert.rejects(corrupt.export(), { status: 503, code: 'FEEDBACK_STORAGE_ERROR' });
});

async function httpFixture(t, directory, overrides = {}) {
  const server = createApp({ feedbackDirectory: directory, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(route, body, headers = {}) {
    const response = await fetch(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { api, origin };
}

test('HTTP feedback survives reset and server recreation while inheriting local-origin protections', async t => {
  const directory = path.join(await temporary(t), 'records');
  const first = await httpFixture(t, directory);
  assert.equal((await first.api('/api/status')).body.keyConfigured, false);
  assert.equal((await first.api('/api/status')).body.version, APP_VERSION);
  assert.deepEqual((await first.api('/api/feedback/status')).body, { count: 0 });
  const meetingId = (await first.api('/api/state')).body.meetingId;
  assert.equal((await first.api('/api/state')).body.session.status, 'idle');
  const request = feedback({ includeContext: true, meetingId });
  const saved = await first.api('/api/feedback', request);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, true);
  await first.api('/api/session/start', {});
  await first.api('/api/session/stop', {});
  assert.equal((await first.api('/api/state')).body.session.status, 'stopped');
  assert.deepEqual((await first.api('/api/feedback', request)).body, { ...saved.body, duplicate: true }, 'feedback retry remains usable after stop');
  assert.equal((await first.api('/api/feedback/export')).body.records[0].appVersion, APP_VERSION);
  await first.api('/api/reset', {});
  assert.deepEqual((await first.api('/api/feedback', request)).body, { ...saved.body, duplicate: true });
  assert.equal((await first.api('/api/feedback', { ...request, submissionId: randomUUID() })).status, 409);
  const restarted = await httpFixture(t, directory, {
    apiKey: 'feedback-version-test-secret', model: 'feedback-private-model', baseUrl: 'https://private-config.invalid'
  });
  assert.deepEqual((await restarted.api('/api/feedback/status')).body, { count: 1 });
  const exported = await restarted.api('/api/feedback/export');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="meeting-feedback.json"');
  assert.equal(exported.body.records[0].id, request.submissionId);
  const exportedText = JSON.stringify(exported.body);
  for (const configValue of ['feedback-version-test-secret', 'feedback-private-model', 'private-config.invalid']) {
    assert.equal(exportedText.includes(configValue), false, 'feedback export must not include provider configuration');
  }
  assert.equal((await restarted.api('/api/feedback', feedback(), { Origin: 'https://other.example' })).status, 403);
  assert.equal((await restarted.api('/api/feedback/export', undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await restarted.api(`/data/feedback/${request.submissionId}.json`)).status, 404);
  const deletion = await fetch(`${restarted.origin}/api/feedback`, { method: 'DELETE' });
  assert.equal(deletion.status, 405);
  assert.deepEqual((await restarted.api('/api/feedback/status')).body, { count: 1 });
});
