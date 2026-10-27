"use strict";

(() => {
  const translations = new Map();
  const tr = (zh, en) => {
    translations.set(zh, { zh, en }); translations.set(en, { zh, en });
    return window.MeetingI18n?.language === "zh" ? zh : en;
  };
  const translateCurrent = value => {
    const pair = translations.get(value);
    return pair ? (window.MeetingI18n?.language === "zh" ? pair.zh : pair.en) : window.MeetingI18n?.retranslate?.(value) ?? value;
  };
  const $ = (id) => document.getElementById(id);
  const dialog = $("feedback-dialog"), form = $("feedback-form"), fields = $("feedback-fields");
  if (!dialog || !form) return;
  const submit = $("feedback-submit"), result = $("feedback-result");
  const stages = new Set(["hands_on", "watched_demo", "concept_only"]);
  const topics = new Set(["timing", "missed_request", "context", "draft", "input", "other"]);
  let pending = false, exporting = false, lastPayloadKey = null, submissionId = null, frozenRequest = null, statusRevision = 0;
  let retryMessage = "";

  function show(text, type = "") {
    result.textContent = text;
    result.className = `feedback-result${type ? ` ${type}` : ""}`;
  }
  function updateBusyState() {
    fields.disabled = pending || exporting;
    submit.disabled = pending || exporting;
    $("feedback-export").disabled = pending || exporting;
    submit.textContent = pending ? tr("正在保存…", "Saving…") : submissionId ? tr("重试保存", "Retry save") : tr("保存反馈", "Save feedback");
    $("feedback-export").textContent = exporting ? tr("正在导出…", "Exporting…") : tr("导出反馈", "Export feedback");
  }
  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { cache: "no-store", ...options, signal: controller.signal, headers: { "Accept-Language": window.MeetingI18n?.language || "en", ...options.headers } });
      let data;
      try { data = await response.json(); } catch { throw new Error(tr("本机服务返回了无法确认的结果。", "The local service returned an unconfirmed result.")); }
      if (!response.ok) {
        const error = new Error(data.error || tr(`保存未完成（${response.status}）。`, `Save failed (${response.status}).`));
        error.code = data.code; error.status = response.status; throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  function updateCount(count) {
    if (Number.isInteger(count) && count >= 0) $("feedback-count").textContent = tr(`这台电脑目前保存了 ${count} 条反馈。`, `${count} feedback record(s) saved on this computer.`);
  }
  async function readCount() {
    const revision = ++statusRevision;
    try {
      const data = await request("/api/feedback/status");
      if (revision === statusRevision) updateCount(data.count);
    } catch {
      if (revision === statusRevision) $("feedback-count").textContent = tr("暂时无法读取反馈数量；请检查本机服务。", "Feedback count unavailable. Check the local service.");
    }
  }
  function readForm() {
    const payload = {
      usageStage: $("feedback-stage").value,
      topic: $("feedback-topic").value,
      message: $("feedback-message").value.trim(),
      expected: $("feedback-expected").value.trim(),
      rating: $("feedback-rating").value ? Number($("feedback-rating").value) : null,
      participantCode: $("feedback-code").value.trim(),
      includeContext: $("feedback-context").checked
    };
    if (!stages.has(payload.usageStage) || !topics.has(payload.topic) || !payload.message) throw new Error(tr("请选择体验阶段与主题，并填写具体反馈。", "Choose your experience stage and topic, then describe your feedback."));
    if (payload.message.length > 4000 || payload.expected.length > 2000 || payload.participantCode.length > 80) throw new Error(tr("反馈文字过长，请按输入框的长度限制缩短后再保存。", "Your feedback is too long. Shorten it to the limits shown in the fields."));
    if (payload.rating !== null && (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5)) throw new Error(tr("请选择 1–5 分，或保留未选择。", "Choose a rating from 1 to 5, or leave it blank."));
    return payload;
  }
  async function save(event) {
    event.preventDefault();
    if (pending || exporting || !form.reportValidity()) return;
    let payload;
    try { payload = readForm(); } catch (error) { show(error.message, "error"); return; }
    pending = true; updateBusyState();
    show(tr("正在保存到这台电脑…", "Saving on this computer…"));
    try {
      // Identity follows the user's form content. Runtime meeting changes must
      // not turn an uncertain retry into another saved feedback record.
      const key = JSON.stringify(payload);
      if (!submissionId || !frozenRequest || key !== lastPayloadKey) {
        if (payload.includeContext) {
          const meeting = await request("/api/state");
          if (typeof meeting.meetingId !== "string" || !meeting.meetingId) throw new Error(tr("无法确认当前会议，尚未提交反馈。可以取消附上使用情况后重试。", "The current meeting could not be confirmed. Feedback has not been submitted. Uncheck session context and retry."));
          payload.meetingId = meeting.meetingId;
        }
        submissionId = newId();
        lastPayloadKey = key;
        frozenRequest = { submissionId, ...payload };
      }
      const data = await request("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frozenRequest)
      });
      if (data.saved !== true || typeof data.id !== "string") throw new Error(tr("服务返回了未能确认保存的结果。", "The service did not confirm that feedback was saved."));
      statusRevision++;
      updateCount(data.count);
      form.reset();
      lastPayloadKey = null; submissionId = null; frozenRequest = null; retryMessage = "";
      show(data.duplicate ? tr("这份反馈已经保存，重试没有产生重复记录。谢谢你的反馈。", "This feedback was already saved. Retrying did not create a duplicate. Thank you.") : tr("反馈已保存在这台电脑。谢谢你告诉我们具体的使用情况。", "Feedback saved on this computer. Thank you for describing your experience."), "success");
    } catch (error) {
      if (error.code === "FEEDBACK_ID_CONFLICT") {
        submissionId = null; lastPayloadKey = null; frozenRequest = null;
        retryMessage = tr("这次提交编号已对应另一份内容。当前文字已保留，再次保存会使用新的编号。", "This submission ID belongs to different content. Your text is retained; saving again will use a new ID.");
      } else if (error.code === "STALE_SESSION") {
        retryMessage = tr("当前会议已变化，这份反馈尚未保存。请取消“附上本次使用情况”后重试；填写的文字仍保留。", "The meeting changed and this feedback has not been saved. Uncheck session context and retry. Your text is retained.");
      } else if (error.status && error.status < 500) {
        retryMessage = tr(`${error.message} 当前文字已保留，可以修改后重试。`, `${error.message} Your text is retained. Edit it and retry.`);
      } else {
        const detail = error.name === "AbortError" ? tr("本机服务等待超时。", "The local service timed out.") : error.message;
        retryMessage = tr(`${detail} 保存结果未确认；重试相同内容不会重复保存，改动后提交将作为新反馈。当前文字已保留。`, `${detail} Saving is unconfirmed. Retrying unchanged content will not duplicate it; changed content is new feedback. Your text is retained.`);
      }
      show(retryMessage, "error");
    } finally {
      pending = false; updateBusyState();
    }
  }
  async function exportFeedback() {
    if (pending || exporting) return;
    exporting = true; updateBusyState();
    show(tr("正在导出已保存的反馈…", "Exporting saved feedback…"));
    try {
      const data = await request("/api/feedback/export");
      if (!Array.isArray(data.records) || !Number.isInteger(data.count)) throw new Error(tr("反馈导出格式不完整，暂未下载。", "The feedback export is incomplete and has not been downloaded."));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `meeting-feedback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      show(tr(`已交给浏览器下载，共 ${data.count} 条反馈。异地试用请将文件交给项目组。`, `Download started: ${data.count} feedback record(s). If testing remotely, share the file with the project team.`), "success");
    } catch (error) { show(tr(`导出未完成：${error.message} 填写中的内容仍保留。`, `Export failed: ${error.message} Your form content is retained.`), "error"); }
    finally { exporting = false; updateBusyState(); }
  }
  $("feedback-open").addEventListener("click", () => {
    if (!dialog.open) dialog.showModal();
    if (!pending && !exporting) $("feedback-stage").focus();
    readCount();
  });
  $("feedback-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => $("feedback-open").focus());
  form.addEventListener("submit", save);
  fields.addEventListener("input", () => {
    if (!pending && !exporting && submissionId) {
      submit.textContent = tr("保存反馈", "Save feedback");
      show(tr("内容已修改。保存时将与上次提交核对；不同内容会作为一份新反馈保存。", "The content changed. Saving will compare it with the previous submission; different content is saved as new feedback."), "");
    } else if (!pending && !exporting) {
      show("");
    }
  });
  $("feedback-export").addEventListener("click", exportFeedback);
  window.addEventListener("meeting-language-changed", () => {
    for (const node of [result, $("feedback-count")]) {
      if (!node) continue;
      const next = translateCurrent(node.textContent);
      if (next !== node.textContent) node.textContent = next;
    }
    retryMessage = translateCurrent(retryMessage);
    updateBusyState();
  });
})();
