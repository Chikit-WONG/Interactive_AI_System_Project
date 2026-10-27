import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './deepseek.mjs';
import { APP_VERSION } from './version.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set(['hands_on', 'watched_demo', 'concept_only']);
const TOPICS = new Set(['timing', 'missed_request', 'context', 'draft', 'input', 'other']);
const INPUT_SOURCES = new Set(['manual', 'browser_mic', 'browser_mixed', 'rehearsal']);
const FIELDS = new Set(['submissionId', 'usageStage', 'topic', 'message', 'expected',
  'rating', 'participantCode', 'includeContext', 'alertId', 'meetingId']);

function text(value, field, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ApiError(400, 'INVALID_FEEDBACK', `${field}格式无效，最多${max}个字符。`);
  }
  return value.trim();
}

function normalize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !FIELDS.has(key))) {
    throw new ApiError(400, 'INVALID_FEEDBACK', '反馈包含不支持的字段。');
  }
  if (typeof body.submissionId !== 'string' || !UUID.test(body.submissionId)) {
    throw new ApiError(400, 'INVALID_FEEDBACK', '提交编号必须是有效的 UUID。');
  }
  if (!STAGES.has(body.usageStage) || !TOPICS.has(body.topic)) {
    throw new ApiError(400, 'INVALID_FEEDBACK', '请选择体验方式与反馈类别。');
  }
  const rating = body.rating === undefined ? null : body.rating;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new ApiError(400, 'INVALID_FEEDBACK', '评分须为空或1至5的整数。');
  }
  if (body.includeContext !== undefined && typeof body.includeContext !== 'boolean') {
    throw new ApiError(400, 'INVALID_FEEDBACK', '是否附带上下文必须为布尔值。');
  }
  return {
    submissionId: body.submissionId.toLowerCase(),
    usageStage: body.usageStage, topic: body.topic,
    message: text(body.message, '反馈内容', 4000, true),
    expected: text(body.expected, '期望行为', 2000),
    rating, participantCode: text(body.participantCode, '参与者代号', 80),
    includeContext: body.includeContext ?? false,
    alertId: text(body.alertId, '提醒编号', 80),
    meetingId: text(body.meetingId, '会议编号', 80)
  };
}

function limitedContext(request, state) {
  if (!request.includeContext) return null;
  if (request.meetingId && request.meetingId !== state?.meetingId) {
    throw new ApiError(409, 'STALE_SESSION', '会议已改变；请取消附带上下文，或在当前会议重新提交。');
  }
  const utterances = Array.isArray(state?.utterances) ? state.utterances : [];
  const alerts = Array.isArray(state?.alerts) ? state.alerts : [];
  const alert = request.alertId ? alerts.find(item => item.id === request.alertId) : null;
  if (request.alertId && !alert) {
    throw new ApiError(400, 'FEEDBACK_ALERT_NOT_FOUND', '当前会议没有这条提醒；请重新选择或取消附带上下文。');
  }
  return {
    inputSourceTypes: [...new Set(utterances.map(item => item.source).filter(source => INPUT_SOURCES.has(source)))],
    utteranceCount: utterances.length,
    alertCount: alerts.length,
    alert: alert ? { id: alert.id, classification: alert.classification, status: alert.status } : null
  };
}

function publicRecord(record) {
  const { requestHash, ...published } = record;
  // Older records retain their original version; absence is never backfilled with this build.
  return { ...published, appVersion: record.appVersion ?? 'unknown' };
}

function storageError(reading = false) {
  return new ApiError(503, 'FEEDBACK_STORAGE_ERROR', reading
    ? '无法读取本机反馈记录，请检查数据目录是否可访问。'
    : '反馈未能完成本机保存确认，请保留内容并使用同一提交编号重试。');
}

export function createFeedbackStore(directory) {
  const root = path.resolve(directory);

  async function readRecord(id) {
    let raw;
    try {
      raw = await readFile(path.join(root, `${id}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw storageError(true);
    }
    try {
      const record = JSON.parse(raw);
      if (record.id !== id || record.sourceType !== 'in_app_feedback' ||
          record.verification !== 'self_reported' || typeof record.requestHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(record.requestHash) || !Number.isFinite(Date.parse(record.createdAt))) {
        throw new Error('Invalid stored record');
      }
      return record;
    } catch {
      throw storageError(true);
    }
  }

  async function records() {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw storageError(true);
    }
    const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') &&
      UUID.test(entry.name.slice(0, -5))).map(entry => entry.name.slice(0, -5));
    const values = await Promise.all(names.map(readRecord));
    if (values.some(value => !value)) throw storageError(true);
    return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async function receipt(record, duplicate) {
    return {
      saved: true, id: record.id, createdAt: record.createdAt, duplicate,
      count: (await records()).length
    };
  }

  function checkDuplicate(record, hash) {
    if (record.requestHash !== hash) {
      throw new ApiError(409, 'FEEDBACK_ID_CONFLICT', '此提交编号已用于不同内容，请为新的反馈生成新的提交编号。');
    }
  }

  return {
    async save(body, state) {
      const request = normalize(body);
      // Session metadata is used only to validate optional context, never as personal data.
      // Retrying a saved submission after a reset still retrieves its original receipt.
      const { meetingId, ...content } = request;
      const requestHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
      const previous = await readRecord(request.submissionId);
      if (previous) {
        checkDuplicate(previous, requestHash);
        return receipt(previous, true);
      }
      const record = {
        schemaVersion: 'meeting-feedback.v1', appVersion: APP_VERSION,
        id: request.submissionId, createdAt: new Date().toISOString(),
        sourceType: 'in_app_feedback', verification: 'self_reported',
        usageStage: request.usageStage, topic: request.topic, message: request.message,
        expected: request.expected, rating: request.rating, participantCode: request.participantCode,
        includeContext: request.includeContext, context: limitedContext(request, state),
        requestHash
      };
      const target = path.join(root, `${record.id}.json`);
      const temporary = path.join(root, `.${record.id}.${randomUUID()}.tmp`);
      let handle;
      let temporaryCreated = false;
      let duplicate = false;
      let savedRecord = record;
      try {
        await mkdir(root, { recursive: true });
        handle = await open(temporary, 'wx', 0o600);
        temporaryCreated = true;
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        try {
          // Publish the completed file atomically without overwriting a concurrent submission.
          await link(temporary, target);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          savedRecord = await readRecord(record.id);
          if (!savedRecord) throw storageError();
          checkDuplicate(savedRecord, requestHash);
          duplicate = true;
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw storageError();
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (temporaryCreated) await unlink(temporary).catch(() => {});
      }
      return receipt(savedRecord, duplicate);
    },
    async status() {
      return { count: (await records()).length };
    },
    async export() {
      const values = await records();
      return {
        schemaVersion: 'meeting-feedback-export.v1', appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
        sourceType: 'in_app_feedback', verification: 'self_reported',
        count: values.length, records: values.map(publicRecord)
      };
    }
  };
}
