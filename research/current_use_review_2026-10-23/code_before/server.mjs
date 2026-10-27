import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { ApiError, analyzeWithDeepSeek } from './deepseek.mjs';
import { createFeedbackStore } from './feedback.mjs';
import { APP_VERSION } from './version.mjs';
import { localizeError } from './language.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const installationId = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 24);
const publicDirectory = path.join(directory, 'public');
const profileFields = ['name', 'role', 'responsibilities', 'privateFacts'];
const defaultProfile = { name: '', role: '', responsibilities: '', privateFacts: '', language: 'en' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function userText(value, name, max = 4000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new ApiError(400, 'BAD_INPUT', `${name}不能为空或超过${max}个字符。`);
  }
  return value.trim();
}

function freshState(profile = defaultProfile, createdAt = new Date().toISOString()) {
  return {
    meetingId: randomUUID(), createdAt, startedAt: null, revision: 0,
    // elapsedMs contains completed active intervals; activeSince starts the current interval.
    session: { status: 'idle', elapsedMs: 0, activeSince: null, generation: 0 },
    profile: { ...profile }, utterances: [], alerts: [], summary: '',
    analysisState: { running: false, lastAnalyzedUtteranceId: null, lastError: null }
  };
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'JSON_REQUIRED', '请求须使用 JSON。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new ApiError(413, 'TOO_LARGE', '单次输入过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'INVALID_JSON', '请求内容不是有效 JSON 对象。'); }
}

export function createApp(overrides = {}, analyze = analyzeWithDeepSeek) {
  const { clock = { now: Date.now, monotonic: () => performance.now() }, feedbackDirectory, ...providerOverrides } = overrides;
  const config = {
    apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 45000, ...providerOverrides
  };
  const timestamp = () => new Date(clock.now()).toISOString();
  const feedback = createFeedbackStore(feedbackDirectory ?? path.join(directory, 'data', 'feedback'));
  let state = freshState(defaultProfile, timestamp());
  let activeMonotonicSince = null;
  let events = [];
  let inFlight = null;
  let profileVersion = 0;
  let lastProfileVersion = -1;
  const log = (type, details = {}) => {
    events.push({ at: timestamp(), type, ...details });
    if (events.length > 5000) events.shift();
    state.revision++;
  };
  const sendJson = (res, value, status = 200, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(value));
  };
  const elapsedNow = () => state.session.elapsedMs + (activeMonotonicSince === null
    ? 0 : Math.max(0, clock.monotonic() - activeMonotonicSince));
  const requireRunning = () => {
    if (state.session.status !== 'running') throw new ApiError(409, 'SESSION_NOT_RUNNING', '请先开始会议；停止时不会接收新发言或分析。');
  };
  const cancelAnalysis = reason => {
    if (!inFlight) return;
    const job = inFlight;
    inFlight = null;
    job.targetState.analysisState.running = false;
    job.targetState.analysisState.lastError = null;
    const error = new ApiError(409, 'STALE_ANALYSIS', '会议已停止、重置或角色已改变，旧分析结果已丢弃。');
    // Settle the HTTP request even if an injected provider ignores AbortSignal.
    job.cancel(error);
    job.controller.abort(error);
    log('analysis_cancelled', { reason });
  };
  async function analyzeCurrent() {
    requireRunning();
    if (!config.apiKey.trim()) throw new ApiError(503, 'KEY_MISSING', '请先在本机 .env 填写 DeepSeek API Key 并重启。');
    if (!state.utterances.length) throw new ApiError(400, 'NO_TRANSCRIPT', '请先加入已经发生的会议发言。');
    if (!state.profile.name || !state.profile.responsibilities) {
      throw new ApiError(400, 'PROFILE_MISSING', '请先设置姓名与职责，助手才能判断相关性。');
    }
    if (inFlight) throw new ApiError(409, 'BUSY', '已有分析正在进行，请等待完成。');
    const all = state.utterances;
    const lastIndex = all.findIndex(u => u.id === state.analysisState.lastAnalyzedUtteranceId);
    const fresh = profileVersion === lastProfileVersion ? all.slice(lastIndex + 1) : all;
    if (!fresh.length) return;
    // Bounded context: include the next unprocessed batch plus earlier context, not future replay text.
    const firstFresh = all.findIndex(u => u.id === fresh[0].id);
    const batch = fresh.slice(0, 30);
    const end = all.findIndex(u => u.id === batch.at(-1).id) + 1;
    const context = all.slice(Math.max(0, firstFresh - 30), end);
    const targetState = state;
    const capturedProfile = profileVersion;
    const capturedGeneration = state.session.generation;
    state.analysisState.running = true;
    state.analysisState.lastError = null;
    log('analysis_started', { throughId: batch.at(-1).id, inputSourceTypes: [...new Set(context.map(u => u.source))] });
    const snapshot = {
      profile: { ...state.profile },
      utterances: context,
      new_utterance_ids: batch.map(u => u.id),
      existing_alerts: state.alerts.filter(a => !a.outdated).slice(-30).map(a => ({
        question: a.question, source_ids: a.source_ids, status: a.status, confirmedText: a.confirmedText
      }))
    };
    const job = { targetState, controller: new AbortController(), cancel: null };
    const cancelled = new Promise((_, reject) => { job.cancel = reject; });
    inFlight = job;
    const pending = Promise.resolve().then(() => analyze(config, snapshot, { signal: job.controller.signal }));
    try {
      const result = await Promise.race([pending, cancelled]);
      if (inFlight !== job || state !== targetState || capturedProfile !== profileVersion ||
          capturedGeneration !== state.session.generation || state.session.status !== 'running') {
        throw new ApiError(409, 'STALE_ANALYSIS', '会议或角色已经改变，旧分析结果已丢弃。');
      }
      for (const item of result.items) {
        const fingerprint = createHash('sha256').update(JSON.stringify([item.source_ids.slice().sort(), item.question])).digest('hex');
        if (state.alerts.some(a => !a.outdated && a.fingerprint === fingerprint)) continue;
        state.alerts.push({
          ...item, id: randomUUID(), fingerprint, createdAt: new Date().toISOString(),
          status: 'pending', confirmedText: '', notNeededReason: '', outdated: false
        });
      }
      state.summary = result.summary;
      state.analysisState.lastAnalyzedUtteranceId = batch.at(-1).id;
      lastProfileVersion = capturedProfile;
      log('analysis_completed', { throughId: batch.at(-1).id, itemCount: result.items.length, model: config.model });
    } catch (error) {
      if (inFlight === job && state === targetState) {
        state.analysisState.lastError = localizeError(error instanceof ApiError ? error.code : 'ANALYSIS_FAILED', error instanceof ApiError ? error.message : '分析失败，输入已保留。', state.profile.language);
        log('analysis_failed', { code: error instanceof ApiError ? error.code : 'ANALYSIS_FAILED' });
      }
      throw error;
    } finally {
      // An earlier cancelled request must never clear a resumed session's new analysis.
      if (inFlight === job) {
        targetState.analysisState.running = false;
        inFlight = null;
        state.revision++;
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
      if (!allowedHosts.has(req.headers.host)) throw new ApiError(403, 'LOCAL_ONLY', '仅允许本机访问。');
      const origin = req.headers.origin;
      if (origin && ![...allowedHosts].some(host => origin === `http://${host}`)) {
        throw new ApiError(403, 'FOREIGN_ORIGIN', '拒绝其他网站发起的本机请求。');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'FOREIGN_ORIGIN', '拒绝跨站请求。');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, {
          appId: 'partial-participation-meeting-assistant', installationId,
          pid: process.pid, version: APP_VERSION, launchId: process.env.MEETING_LAUNCH_ID || null
        });
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, { keyConfigured: !!config.apiKey.trim(), model: config.model, transcription: 'manual_or_experimental_browser_audio', integration: 'companion', version: APP_VERSION });
      }
      if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, state);
      if (req.method === 'GET' && pathname === '/api/feedback/status') {
        return sendJson(res, await feedback.status());
      }
      if (req.method === 'GET' && pathname === '/api/feedback/export') {
        return sendJson(res, await feedback.export(), 200, {
          'Content-Disposition': 'attachment; filename="meeting-feedback.json"'
        });
      }
      if (req.method === 'GET' && pathname === '/api/rehearsal') {
        const language = url.searchParams.get('lang') || state.profile.language;
        const filename = language === 'zh' ? 'script.json' : 'script.en.json';
        return sendJson(res, JSON.parse(await readFile(path.join(directory, 'rehearsal', filename), 'utf8')));
      }
      if (req.method === 'GET' && pathname === '/api/export') {
        return sendJson(res, {
          schemaVersion: 'companion.v0.3', appVersion: APP_VERSION, exportedAt: timestamp(),
          sessionElapsedMsAtExport: elapsedNow(),
          integration: 'standalone_companion', inputSourceTypes: [...new Set(state.utterances.map(u => u.source))],
          delivery: 'user_copy_and_manual_send', responseValidity: 'not_evaluated',
          ...state, events
        }, 200, { 'Content-Disposition': 'attachment; filename="meeting-session.json"' });
      }
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        const body = await readJson(req);
        if (pathname === '/api/feedback') return sendJson(res, await feedback.save(body, state));
        if (body.meetingId !== undefined && body.meetingId !== state.meetingId) {
          throw new ApiError(409, 'STALE_SESSION', '这条操作属于上一场会议，未加入当前会话。');
        }
        if (body.sessionGeneration !== undefined && body.sessionGeneration !== state.session.generation) {
          throw new ApiError(409, 'STALE_SESSION_GENERATION', '会议的开始或停止状态已改变，这条过期操作未执行。');
        }
        if (pathname === '/api/session/start') {
          if (state.session.status !== 'running') {
            const startedAt = timestamp();
            state.startedAt ??= startedAt;
            state.session.status = 'running';
            state.session.activeSince = startedAt;
            state.session.generation++;
            activeMonotonicSince = clock.monotonic();
            log('session_started', { generation: state.session.generation });
          }
        } else if (pathname === '/api/session/stop') {
          if (state.session.status === 'running') {
            state.session.elapsedMs = elapsedNow();
            state.session.status = 'stopped';
            state.session.activeSince = null;
            state.session.generation++;
            activeMonotonicSince = null;
            cancelAnalysis('session_stopped');
            log('session_stopped', { generation: state.session.generation, elapsedMs: state.session.elapsedMs });
          }
        } else if (pathname === '/api/utterances') {
          requireRunning();
          if (state.utterances.length >= 1000) throw new ApiError(409, 'SESSION_FULL', '本次发言已达1000条，请导出后新建会议。');
          if (!['manual', 'browser_mic', 'browser_mixed', 'rehearsal'].includes(body.source)) throw new ApiError(400, 'INVALID_SOURCE', '请选择输入方式。');
          const record = {
            id: `u${state.utterances.length + 1}`, speaker: userText(body.speaker, '发言人', 100),
            text: userText(body.text, '发言内容'), source: body.source, at: new Date().toISOString()
          };
          state.utterances.push(record);
          log('utterance_added', { id: record.id, source: record.source });
        } else if (pathname === '/api/profile') {
          const next = {};
          for (const key of profileFields) next[key] = userText(body[key] ?? '', key, key === 'name' ? 100 : 4000, true);
          next.language = body.language ?? state.profile.language;
          if (!['en', 'zh'].includes(next.language)) throw new ApiError(400, 'INVALID_LANGUAGE', '请选择英文或中文。');
          const contentChanged = profileFields.some(key => next[key] !== state.profile[key]);
          const languageChanged = next.language !== state.profile.language;
          if (contentChanged) {
            cancelAnalysis('profile_changed');
            state.profile = next;
            profileVersion++;
            const outdatedAt = new Date().toISOString();
            for (const alert of state.alerts) {
              if (alert.status !== 'sent' && !alert.outdated) {
                alert.outdated = true;
                alert.outdatedAt = outdatedAt;
              }
            }
            state.summary = '';
            state.analysisState.lastAnalyzedUtteranceId = null;
            state.analysisState.lastError = null;
            log('profile_updated');
          } else if (languageChanged) {
            // Display preference affects future AI output, not historical evidence or edited replies.
            cancelAnalysis('language_changed');
            state.profile.language = next.language;
            log('language_updated', { language: next.language });
          }
        } else if (pathname === '/api/analyze') {
          await analyzeCurrent();
        } else if (pathname === '/api/reset') {
          cancelAnalysis('meeting_reset');
          state = freshState(state.profile, timestamp());
          activeMonotonicSince = null;
          events = [];
          lastProfileVersion = -1;
          log('meeting_created');
        } else if (/^\/api\/alerts\/[^/]+\/action$/.test(pathname)) {
          const id = pathname.split('/')[3];
          const alert = state.alerts.find(a => a.id === id);
          if (!alert) throw new ApiError(404, 'NOT_FOUND', '没有找到这条提醒。');
          if (alert.outdated) throw new ApiError(409, 'OUTDATED_ALERT', '角色或背景已改变，这条旧提醒仅保留为历史；请重新分析后使用新提醒。');
          const action = body.action;
          if (action === 'confirm') {
            if (['sent', 'not_needed'].includes(alert.status)) throw new ApiError(409, 'INVALID_TRANSITION', '请先恢复待处理状态，或查看已发送记录。');
            alert.confirmedText = userText(body.text, '回复', 4000);
            alert.status = 'confirmed';
            alert.confirmedAt = new Date().toISOString();
            alert.copiedAt = null;
          } else if (action === 'mark_sent') {
            if (alert.status !== 'confirmed') throw new ApiError(409, 'NOT_CONFIRMED', '请先确认回复，再记录人工发送。');
            alert.status = 'sent';
            alert.sentAt = new Date().toISOString();
            alert.deliveryEvidence = 'self_reported_manual_send';
          } else if (action === 'copy') {
            if (!['confirmed', 'sent'].includes(alert.status)) throw new ApiError(409, 'NOT_CONFIRMED', '请先确认需要复制的回复。');
            alert.copiedAt = new Date().toISOString();
          } else if (action === 'not_needed') {
            if (alert.status === 'sent') throw new ApiError(409, 'ALREADY_SENT', '已发送的记录不能改成无需回应。');
            alert.notNeededReason = userText(body.reason, '原因', 500);
            alert.status = 'not_needed';
          } else if (action === 'restore') {
            if (!['not_needed', 'deferred'].includes(alert.status)) throw new ApiError(409, 'INVALID_TRANSITION', '当前记录无需恢复。');
            alert.status = 'pending';
            alert.notNeededReason = '';
          } else if (action === 'defer') {
            if (alert.status !== 'pending') throw new ApiError(409, 'INVALID_TRANSITION', '只有待处理的提醒可以暂缓。');
            alert.status = 'deferred';
          } else throw new ApiError(400, 'INVALID_ACTION', '未知操作。');
          log(`alert_${action}`, { alertId: id, status: alert.status, delivery: action === 'mark_sent' ? 'self_reported' : undefined });
        } else throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
        return sendJson(res, state);
      }
      if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持。');
      const target = path.resolve(publicDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!target.startsWith(`${publicDirectory}${path.sep}`) || !MIME[path.extname(target)] || !(await stat(target).catch(() => null))?.isFile()) {
        throw new ApiError(404, 'NOT_FOUND', '文件不存在。');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] });
      res.end(await readFile(target));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : 'SERVER_ERROR';
      const requestedLanguage = req.headers['accept-language']?.split(',')[0].split(';')[0].trim();
      const errorLanguage = /^zh(?:-|$)/i.test(requestedLanguage || '') ? 'zh'
        : /^en(?:-|$)/i.test(requestedLanguage || '') ? 'en' : state.profile.language;
      sendJson(res, { error: localizeError(code, error instanceof ApiError ? error.message : '请求暂未完成，请重试。', errorLanguage), code }, status);
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const envFile = path.join(directory, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || 8765);
  const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    console.error('Invalid PORT or DEEPSEEK_TIMEOUT_MS.');
    process.exit(1);
  }
  const server = createApp({
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    timeoutMs
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'The port is in use. Stop the previous service or update PORT in .env.' : 'The local service could not start.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Meeting Cue: http://127.0.0.1:${port}`);
    console.log('Local meeting companion with browser audio capture. API credentials are never printed in logs.');
  });
}
