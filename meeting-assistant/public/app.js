"use strict";

(() => {
  const t = window.MeetingI18n.t;
  const $ = (id) => document.getElementById(id);
  const CATEGORY = { action_now: t("需回应"), defer: t("稍后"), awareness: t("了解即可") };
  const STATUS = { pending: t("待判断"), confirmed: t("已确认草稿，未记录发送"), sent: t("已人工记录发送"), not_needed: t("已标记无需回应"), deferred: t("稍后处理") };
  const REASONS = { not_my_role: t("不属于我的职责"), already_handled: t("已经有人处理"), no_action_needed: t("只需了解，不必回应"), other: t("其他原因") };
  const SOURCES = { manual: t("人工输入"), browser_mic: t("麦克风转写"), browser_mixed: t("会议声音＋麦克风（说话人未区分）"), rehearsal: t("演练回放") };
  let state = null, service = null, filter = "all", openAlertId = null, mode = "manual";
  let profileDirty = false, profileTimer = null, profileSaving = null, profileVersion = 0;
  let analysisBusy = false, autoTimer = null, lastTextAt = 0, lastAutoAttempt = "", autoPendingSince = 0;
  let manualBusy = false;
  let pollBusy = false, resetting = false, sessionTransition = false, toastTimer = null, sessionGeneration = 0;
  let speech = null, speechActive = false, speechWanted = false, speechGeneration = 0;
  let systemAudioActive = false, systemAudioPending = false;
  let systemAudioInput = t("会议声音＋麦克风");
  let replay = null, replayIndex = 0, replaySeconds = 0, replayRunning = false, replayLastTick = 0, replayBusy = false;
  const drafts = new Map(), clientEvents = [], retiredMeetings = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function log(type, details = {}) { clientEvents.push({ at: new Date().toISOString(), type, ...details }); }
  function toast(text) {
    $("toast").textContent = text; $("toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
  }
  function fail(error) {
    const text = error instanceof Error ? error.message : String(error);
    $("analysis-error").textContent = text; $("analysis-error").hidden = false;
    log("ui_error", { message: text });
  }
  async function api(path, method = "GET", body) {
    if (body !== undefined && state?.meetingId) body = { meetingId: state.meetingId, ...body };
    if (body !== undefined && ["/api/utterances", "/api/analyze", "/api/session/start", "/api/session/stop"].includes(path)) body = { sessionGeneration: state?.session?.generation, ...body };
    const response = await fetch(path, { method, headers: { "Accept-Language": window.MeetingI18n.language, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let data;
    try { data = await response.json(); } catch { throw new Error(t("服务返回了无法读取的内容，请检查本机服务是否正常运行。")); }
    if (!response.ok) throw new Error(data.error || t`请求失败（${response.status}）`);
    return data;
  }
  function timeLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("时间未提供") : date.toLocaleTimeString(window.MeetingI18n.speechLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  function duration(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }
  function lastUtteranceId() { return state?.utterances?.at(-1)?.id || ""; }
  function activeAlert() { return state?.alerts?.find((a) => a.id === openAlertId); }
  function sessionRunning() { return state?.session?.status === "running" && !sessionTransition && !resetting; }
  function broadcastSession() {
    window.dispatchEvent(new CustomEvent("meeting-session-state", { detail: { running: sessionRunning(), generation: state?.session?.generation, meetingId: state?.meetingId } }));
  }
  function syncSessionControls() {
    const running = sessionRunning();
    $("start-session").disabled = !state || sessionTransition || resetting || state.session?.status === "running";
    $("start-session").textContent = state?.session?.status === "stopped" ? t("继续会话") : t("开始会话");
    $("stop-session").disabled = !state || sessionTransition || resetting || state.session?.status !== "running";
    $("reset-meeting").disabled = !state || sessionTransition || resetting;
    $("add-transcript").disabled = !running || manualBusy;
    syncAnalysisControls();
    $("start-speech").disabled = !running || !(window.SpeechRecognition || window.webkitSpeechRecognition) || speechActive || speechWanted;
    $("stop-speech").disabled = !speechActive && !speechWanted;
    $("start-replay").disabled = !running || !replay || replayRunning || replayIndex >= replay.utterances.length;
    $("stop-replay").disabled = !replayRunning;
    $("session-state").textContent = sessionTransition ? t("正在切换…") : !state ? t("正在读取会话") : state.session?.status === "running" ? t("会话进行中") : state.session?.status === "stopped" ? t("会话已停止") : t("会话未开始");
    $("session-hint").textContent = state?.session?.status === "running" ? t("会话计时中。采集声音、播放剧本和自动分析需分别开启；停止会保留记录。") : state?.session?.status === "stopped" ? t("记录已保留，计时和采集已停止。继续会话后，请自行重新开启需要的输入和分析。") : t("点击开始后才计时。停止会保留记录，并停止采集、回放与自动分析。");
  }
  function profileComplete() { const profile = readProfile(); return Boolean(profile.name && profile.responsibilities); }
  function syncAnalysisControls() {
    const running = sessionRunning(), count = state?.utterances?.length || 0;
    const busy = analysisBusy || Boolean(state?.analysisState?.running), draft = $("transcript-input").value.trim();
    const complete = profileComplete(), automatic = $("auto-analyze").checked;
    $("analyze-button").disabled = !running || !count || !service?.keyConfigured || !complete || busy;
    $("analyze-button").textContent = busy ? t("正在分析…") : t("立即分析一次");
    $("auto-analyze").disabled = !running || !service?.keyConfigured;
    $("analysis-mode-state").textContent = automatic ? t("已开启") : t("未开启");
    let reason, action = "", label = "";
    if (!state || sessionTransition || resetting) reason = t("正在确认会话状态，请稍候。");
    else if (!running) {
      const stopped = state.session?.status === "stopped";
      reason = t`${stopped ? t("会话已停止，请先继续会话") : t("会话尚未开始，请先开始会话")}。已接收 ${count} 条发言${draft ? t("；输入框中的文字还未加入记录") : ""}。`;
      action = "start"; label = stopped ? t("继续会话") : t("开始会话");
    } else if (!service) reason = t("尚未确认 DeepSeek 配置，请等待服务连接。");
    else if (!service.keyConfigured) reason = t("本机服务尚未配置 API 密钥。填写后重启服务，再刷新页面。");
    else if (!complete) {
      reason = t("请先填写你的称呼和负责的事项，助手才能判断哪些发言与你有关。");
      action = "profile"; label = t("补全角色设置");
    } else if (busy) reason = t("DeepSeek 正在分析已加入的发言，完成后会显示结果。");
    else if (draft) {
      reason = t`输入框里的文字还未加入记录。${automatic ? t("加入后会自动分析") : t("加入后即可分析")}；当前已接收 ${count} 条。`;
      action = "add"; label = automatic ? t("加入记录，等待自动分析") : t("将输入文字加入记录");
    } else if (!count) {
      reason = t`尚未收到发言。请加入文字、开启语音转写或播放演练。${automatic ? t("自动分析已就绪，收到文字后会开始。") : t("演示时可先开启上方的自动分析。")}`;
      action = "input"; label = t("前往接收会议内容");
    } else if (automatic) reason = t("自动分析已开启：有未处理的新发言时会自动提交，无需反复点击按钮。");
    else reason = t`已接收 ${count} 条发言。演示时开启上方“自动分析新发言”，也可以立即分析一次。`;
    $("analysis-ready-reason").textContent = reason;
    $("analyze-button").title = $("analyze-button").disabled ? reason : t("立即处理当前未分析的发言");
    $("analysis-next-step").hidden = !action;
    $("analysis-next-step").dataset.action = action;
    $("analysis-next-step").textContent = label;
    $("analysis-next-step").disabled = action === "add" && manualBusy;
  }
  function stopLocalActivity() {
    sessionGeneration++; analysisBusy = false; lastAutoAttempt = ""; autoPendingSince = 0;
    clearTimeout(autoTimer); $("auto-analyze").checked = false;
    window.dispatchEvent(new CustomEvent("meeting-stop-system-audio"));
    stopSpeech(); pauseReplay();
  }
  async function changeSession(action) {
    if (!state || sessionTransition || resetting) return;
    sessionTransition = true;
    if (action === "stop") stopLocalActivity();
    broadcastSession(); syncSessionControls();
    try {
      const next = await api(`/api/session/${action}`, "POST", {});
      acceptState(next);
      $("analysis-status").textContent = action === "stop" ? t("会话已停止，已有记录保留；不会继续采集或自动分析。") : service?.keyConfigured ? t("会话已开启。请选择输入方式；自动分析需要手动开启。") : t("会话已开启，本机服务尚未配置 API 密钥。可先输入或回放内容。");
      toast(action === "stop" ? t("已停止会话，记录已保留。") : t("已开启会话；请自行启动需要的输入。"));
    } catch (error) {
      fail(new Error(action === "stop" ? t`本页采集已停止，但服务端停止状态未确认：${error.message} 请重试停止。` : error.message));
    } finally { sessionTransition = false; render(); broadcastSession(); }
  }
  // Review basis: Opus 5.5 High r1 Q7 F08/F09 and Gemini 4 Argon High r1 Q7,
  // research/assistant_feedback_2026-10-20/raw/. This changes display only.
  function draftChanged(alert) {
    return Boolean(alert.confirmedText && drafts.has(alert.id) && drafts.get(alert.id).trim() !== alert.confirmedText.trim());
  }
  function alertStatusLabel(alert) {
    if (alert.status === "confirmed" && alert.copiedAt) {
      return draftChanged(alert) ? t("上版已复制 · 当前草稿待重新确认") : t("已复制，待本人发送或记录");
    }
    return STATUS[alert.status] || alert.status;
  }
  function readProfile() { return { language: window.MeetingI18n.language, name: $("user-name").value.trim(), role: $("user-role").value.trim(), responsibilities: $("user-responsibilities").value.trim(), privateFacts: $("user-context").value.trim() }; }
  function fillProfile(profile = {}) {
    $("user-name").value = profile.name || ""; $("user-role").value = profile.role || "";
    $("user-responsibilities").value = profile.responsibilities || ""; $("user-context").value = profile.privateFacts || "";
  }
  async function saveProfile() {
    clearTimeout(profileTimer);
    if (profileSaving) { await profileSaving; if (!profileDirty) return; }
    if (!profileDirty) return;
    const version = profileVersion, profile = readProfile();
    $("role-save-state").textContent = t("正在保存…");
    profileSaving = (async () => {
      try {
        const next = await api("/api/profile", "POST", profile);
        if (version === profileVersion) profileDirty = false;
        acceptState(next);
        $("role-save-state").textContent = profileDirty ? t("有修改待保存") : t("已保存，用于下一次分析");
      } catch (error) { $("role-save-state").textContent = t("保存失败，请重试"); throw error; }
      finally { profileSaving = null; }
    })();
    await profileSaving;
    if (profileDirty) return saveProfile();
  }
  function acceptState(next, force = false) {
    if (!next || !Array.isArray(next.utterances) || !Array.isArray(next.alerts)) return;
    if (!force && retiredMeetings.has(next.meetingId)) return;
    if (!force && state?.meetingId === next.meetingId && Number(next.revision) < Number(state.revision)) return;
    const prevLast = lastUtteranceId();
    const profileInvalidated = state?.meetingId === next.meetingId && state?.analysisState?.lastAnalyzedUtteranceId && !next.analysisState?.lastAnalyzedUtteranceId;
    const first = !state;
    const boundaryChanged = first || state.meetingId !== next.meetingId || state.session?.generation !== next.session?.generation;
    if (state?.meetingId && state.meetingId !== next.meetingId) retiredMeetings.add(state.meetingId);
    state = next;
    if (boundaryChanged) stopLocalActivity();
    if (replay) {
      const played = state.utterances.filter((u) => u.source === "rehearsal");
      if (played.every((u, i) => u.text === replay.utterances[i]?.text)) replayIndex = Math.max(replayIndex, played.length);
    }
    if (first && !profileDirty) fillProfile(state.profile);
    render();
    broadcastSession();
    if (profileInvalidated) {
      lastAutoAttempt = "";
      $("analysis-status").textContent = t("角色或背景已修改。旧建议保留供回看，请重新分析后使用新的草稿。");
    }
    if (lastUtteranceId() !== prevLast || profileInvalidated) { lastTextAt = Date.now(); scheduleAuto(); }
  }
  function transcriptNode(item) {
    const row = el("article", "transcript-item");
    const meta = el("div", "transcript-meta");
    meta.append(el("span", "source-id", item.id), el("strong", "", item.speaker || t("未注明")), el("span", "", SOURCES[item.source] || item.source || t("来源未注明")), el("time", "", timeLabel(item.at)));
    row.append(meta, el("p", "", item.text || ""));
    return row;
  }
  function empty(container, title, description, icon = "↗") {
    const box = el("div", "empty-state");
    box.append(el("span", "empty-icon", icon), el("h3", "", title), el("p", "", description));
    container.replaceChildren(box);
  }
  function render() {
    const items = state?.utterances || [], alerts = state?.alerts || [];
    $("transcript-count").textContent = t`${items.length} 条`;
    const list = $("transcript-list"), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    if (items.length) list.replaceChildren(...items.map(transcriptNode));
    else empty(list, t("从一段发言开始"), t("新的内容会带上时间与 ID，便于核对提醒依据。"), "“");
    if (atBottom) list.scrollTop = list.scrollHeight;
    $("analysis-badge").textContent = analysisBusy || state?.analysisState?.running ? t("分析中") : items.length ? t`${alerts.length} 条建议` : t("等待内容");
    $("all-count").textContent = alerts.length;
    $("now-count").textContent = alerts.filter((a) => a.classification === "action_now").length;
    $("later-count").textContent = alerts.filter((a) => a.classification === "defer").length;
    $("awareness-count").textContent = alerts.filter((a) => a.classification === "awareness").length;
    const filtered = alerts.filter((a) => filter === "all" || a.classification === filter);
    if (filtered.length) $("alert-list").replaceChildren(...filtered.map(alertNode));
    else empty($("alert-list"), alerts.length ? t("这一类暂时没有建议") : t("保留你的判断"), alerts.length ? t("可以查看全部建议，或等待新的讨论内容。") : t("AI 建议会附上原话。你可以编辑回复、稍后处理，或说明无需回应。"));
    $("summary-box").hidden = !state?.summary;
    $("meeting-summary").textContent = typeof state?.summary === "string" ? state.summary : "";
    $("summary-time").textContent = state?.analysisState?.lastAnalyzedUtteranceId ? t`已分析至 ${state.analysisState.lastAnalyzedUtteranceId}` : "";
    if (openAlertId && $("alert-dialog").open) updateDialog(false);
    syncSessionControls();
    updateClock();
  }
  function alertNode(alert) {
    const classes = { action_now: "", defer: "respond_later", awareness: "awareness_only" };
    const row = el("article", `alert-card ${classes[alert.classification] || ""} ${alert.status === "sent" ? "completed" : ""} ${alert.status === "not_needed" || alert.outdated ? "declined" : ""}`);
    row.dataset.alertId = alert.id;
    const head = el("div", "alert-card-header");
    head.append(el("span", "", CATEGORY[alert.classification] || t("待核对")), el("span", "", alert.outdated ? t("背景已修改 · 旧建议") : alertStatusLabel(alert)));
    row.append(head, el("h3", "", alert.question || t("查看这段讨论")), el("p", "", alert.reason || t("请查看原话判断。")));
    const foot = el("div", "alert-card-footer"), button = el("button", "", alert.outdated ? t("查看历史建议") : alert.status === "not_needed" ? t("查看 / 恢复") : t("查看原话与处理"));
    const sourceIds = Array.isArray(alert.source_ids) ? alert.source_ids : [];
    foot.append(el("span", "", sourceIds.length ? t`来源 ${sourceIds.join(" · ")}` : t("未提供来源")), button);
    button.addEventListener("click", () => openAlert(alert.id));
    row.append(foot);
    return row;
  }
  function openAlert(id) {
    openAlertId = id; updateDialog(true);
    if (!$("alert-dialog").open) $("alert-dialog").showModal();
    log("alert_open", { alertId: id });
  }
  function updateDialog(initial) {
    const alert = activeAlert();
    if (!alert) { $("alert-dialog").close(); openAlertId = null; return; }
    $("dialog-category").textContent = CATEGORY[alert.classification] || t("待核对");
    $("alert-dialog-title").textContent = alert.question || t("查看这段讨论");
    $("dialog-state").textContent = alert.outdated ? t("角色或背景已修改，此建议仅供回看。请关闭详情并重新分析。") : `${alertStatusLabel(alert)}${alert.notNeededReason ? ` · ${REASONS[alert.notNeededReason] || alert.notNeededReason}` : ""}`;
    $("dialog-reason").textContent = alert.reason || t("请结合原话与自己的职责判断。");
    $("dialog-context").textContent = alert.context || t("以下原话是该建议引用的讨论，请核对其中的具体条件。");
    $("dialog-timing").textContent = [alert.deadline ? t`AI 提及的时间要求：${alert.deadline}` : t("未给出明确截止时间。"), alert.uncertainty ? t`待核实：${alert.uncertainty}` : ""].filter(Boolean).join(" ");
    const sourceIds = Array.isArray(alert.source_ids) ? alert.source_ids : [];
    const sources = sourceIds.map((id) => state.utterances.find((u) => u.id === id)).filter(Boolean);
    $("dialog-sources").replaceChildren(...sources.map(transcriptNode));
    if (sources.length !== sourceIds.length || !sources.length) $("dialog-sources").append(el("p", "small muted", t("部分或全部引用未找到，请先核查完整发言记录。")));
    if (initial) {
      $("reply-draft").value = drafts.has(alert.id) ? drafts.get(alert.id) : alert.confirmedText || alert.draft || "";
      $("copy-status").textContent = "";
      $("not-needed-reason").value = alert.notNeededReason || "";
    }
    $("restore-alert").hidden = alert.status !== "not_needed" && alert.status !== "deferred";
    $("mark-not-needed").hidden = alert.status === "not_needed";
    $("not-needed-reason").disabled = alert.status === "not_needed";
    $("mark-sent").disabled = alert.status !== "confirmed" || !alert.confirmedText || $("reply-draft").value.trim() !== alert.confirmedText.trim();
    $("copy-reply").disabled = alert.status === "not_needed" || alert.status === "sent";
    $("mark-not-needed").disabled = alert.status === "sent";
    $("snooze-alert").disabled = alert.status !== "pending";
    $("draft-origin").textContent = alert.confirmedText ? t("已有人工确认的草稿；修改后需重新确认。复制与发送分别记录。") : t("草稿由 AI 建议，尚未发送。");
    if (alert.status === "confirmed" && draftChanged(alert)) {
      $("draft-origin").textContent = alert.copiedAt ? t("先前版本已复制；当前编辑稿尚未确认或复制，请重新确认并复制后再发送。") : t("当前草稿已修改，尚未重新确认；请核对后重新确认并复制。");
    } else if (alert.status === "confirmed" && alert.copiedAt) {
      $("draft-origin").textContent = t("这份草稿已复制，待本人在会议中发送或记录已发送。复制不会自动发送到腾讯会议。");
    }
    $("reply-draft").readOnly = Boolean(alert.outdated);
    $("restore-alert").disabled = Boolean(alert.outdated || profileDirty || profileSaving);
    if (alert.outdated) $("draft-origin").textContent = t("这是修改背景前的历史草稿，不可继续确认或复制；人工编辑内容已保留。");
    if (alert.outdated || profileDirty || profileSaving) {
      for (const id of ["copy-reply", "mark-sent", "snooze-alert", "mark-not-needed", "not-needed-reason"]) $(id).disabled = true;
    }
  }
  async function action(name, fields = {}, id = openAlertId) {
    if (!id) return;
    await saveProfile();
    const next = await api(`/api/alerts/${encodeURIComponent(id)}/action`, "POST", { action: name, ...fields });
    acceptState(next);
    return id;
  }
  async function addManual() {
    if (manualBusy) return;
    if (!sessionRunning()) { toast(t("请先开始或继续会话。")); return; }
    const input = $("transcript-input"), text = input.value.trim();
    if (!text) { toast(t("先输入一段发言。")); return; }
    manualBusy = true; $("add-transcript").disabled = true;
    const generation = sessionGeneration, meetingId = state?.meetingId, serverGeneration = state?.session?.generation;
    try {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => line.length > 4000)) throw new Error(t("单条发言最多 4000 个字符，请将长段文字分成几行后加入。"));
      for (let i = 0; i < lines.length; i++) {
        if (generation !== sessionGeneration || resetting) return;
        const match = lines[i].match(/^([^：:]{1,40})[：:]\s*(.+)$/);
        const speaker = match ? match[1].trim() : $("speaker-name").value.trim() || t("未注明");
        const content = match ? match[2] : lines[i];
        const next = await api("/api/utterances", "POST", { speaker, text: content, source: "manual", meetingId, sessionGeneration: serverGeneration });
        if (generation !== sessionGeneration) return;
        acceptState(next);
        input.value = lines.slice(i + 1).join("\n");
      }
      setMode("manual"); toast(t`已加入 ${lines.length} 条发言。`);
    } catch (error) { if (generation === sessionGeneration) fail(error); } finally { manualBusy = false; syncSessionControls(); }
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!sessionRunning() || !$("auto-analyze").checked || !service?.keyConfigured || !profileComplete() || !lastUtteranceId()) { autoPendingSince = 0; return; }
    const pendingId = lastUtteranceId();
    if (pendingId === state?.analysisState?.lastAnalyzedUtteranceId || pendingId === lastAutoAttempt) { autoPendingSince = 0; return; }
    if (!autoPendingSince) autoPendingSince = Date.now();
    if (analysisBusy || state?.analysisState?.running) { autoTimer = setTimeout(scheduleAuto, 500); return; }
    autoTimer = setTimeout(() => {
      if (analysisBusy || state?.analysisState?.running) { scheduleAuto(); return; }
      analyze(true);
    }, Math.max(150, Math.min(4000 - (Date.now() - lastTextAt), 12000 - (Date.now() - autoPendingSince))));
  }
  async function analyze(automatic = false) {
    if (!sessionRunning() || !service?.keyConfigured || analysisBusy || state?.analysisState?.running || !lastUtteranceId()) return;
    if (!profileComplete()) { syncAnalysisControls(); return; }
    const generation = sessionGeneration, meetingId = state.meetingId, serverGeneration = state.session.generation;
    analysisBusy = true; clearTimeout(autoTimer); autoPendingSince = 0;
    if (automatic) lastAutoAttempt = lastUtteranceId();
    $("analysis-error").hidden = true;
    $("analysis-status").textContent = t("正在依据角色、职责与已发生的讨论生成建议…"); render();
    try {
      await saveProfile();
      if (generation !== sessionGeneration || !sessionRunning()) return;
      const next = await api("/api/analyze", "POST", { meetingId, sessionGeneration: serverGeneration });
      if (generation !== sessionGeneration) return;
      acceptState(next);
      if (state.analysisState?.lastAnalyzedUtteranceId !== lastUtteranceId()) lastAutoAttempt = "";
      $("analysis-status").textContent = t`分析已更新${state.analysisState?.lastAnalyzedUtteranceId ? t` · 至 ${state.analysisState.lastAnalyzedUtteranceId}` : ""}。请核对原话后处理。`;
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const autoWasOn = $("auto-analyze").checked;
      $("auto-analyze").checked = false; autoPendingSince = 0; clearTimeout(autoTimer);
      $("analysis-status").textContent = t`本次分析未完成；原发言和人工操作仍保留。${autoWasOn ? t("自动分析已暂停，处理错误后可重新开启或手动重试。") : ""}`;
      fail(error);
    } finally {
      if (generation === sessionGeneration) { analysisBusy = false; render(); scheduleAuto(); }
    }
  }
  function setMode(next) {
    mode = next;
    $("input-mode").textContent = next === "browser_mixed" ? `${systemAudioInput} · ${systemAudioActive ? t("采集中") : systemAudioPending ? t("等待启动") : t("未采集")}` : next === "browser_mic" ? t`麦克风转写${speechActive ? t(" · 采集中") : t(" · 未采集")}` : next === "rehearsal" ? t`演练回放${replayRunning ? t(" · 运行中") : t(" · 已暂停")}` : t("人工输入");
    $("input-mode").className = `status-pill${next === "browser_mic" || next === "browser_mixed" ? " mic" : next === "rehearsal" ? " replay" : ""}`;
    updateMonitor();
  }
  // Opus r1 Q7 F04/F07: connection success is not evidence of capture,
  // received transcript, or automatic analysis. Keep these states separate.
  function updateMonitor() {
    let input;
    if (systemAudioActive) input = t`${systemAudioInput} · 采集中（实验，未区分说话人）`;
    else if (systemAudioPending) input = `${systemAudioInput} · ${$("meeting-audio-source")?.value === "window" ? t("等待范围确认、权限或语音服务启动") : t("等待权限或语音服务启动")}`;
    else if (speechActive) input = t`本机麦克风 · ${speechWanted ? t("采集中") : t("正在停止")}`;
    else if (speechWanted) input = t("本机麦克风 · 等待语音服务启动");
    else if (mode === "rehearsal") input = t`演练回放 · ${replayRunning ? t("正在播放") : t("未播放或已暂停")}（未采集声音）`;
    else if (mode === "browser_mic" || mode === "browser_mixed") input = t("麦克风 / 会议声音 · 未采集");
    else input = t("人工输入 · 未采集声音");
    $("monitor-input").textContent = t`输入：${input}`;
    const latest = state?.utterances?.at(-1);
    let recent = t("尚未收到任何发言文字");
    if (latest) {
      const elapsed = Math.max(0, Math.floor((Date.now() - new Date(latest.at).getTime()) / 1000));
      const ago = Number.isFinite(elapsed) ? elapsed < 60 ? t`${elapsed} 秒前` : t`${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒前` : t("时间未确认");
      recent = `${ago} · ${latest.id} · ${SOURCES[latest.source] || t("来源未注明")}`;
    }
    $("monitor-recent").textContent = t`最近文字：${recent}`;
    $("monitor-analysis").textContent = !service ? t("自动分析：尚未确认服务配置") : !service.keyConfigured ? t("自动分析：不可用（未配置 API 密钥）") : $("auto-analyze").checked ? profileComplete() ? t("自动分析：开启 · 停顿 4 秒或持续输入 12 秒后提交，等待前次完成") : t("自动分析：已开启，等待补全称呼与职责") : t("自动分析：关闭 · 收到文字后仍需手动分析");
    if (!sessionRunning()) $("monitor-analysis").textContent = state?.session?.status === "stopped" ? t("分析已停止 · 继续会话后可按需开启") : t("会话尚未开始 · 开始后可输入和分析");
  }
  function selectSource(name) {
    window.dispatchEvent(new CustomEvent("meeting-stop-system-audio"));
    const nextMode = { manual: "manual", microphone: "browser_mic", replay: "rehearsal" }[name];
    if (name !== "microphone") stopSpeech();
    if (name !== "replay") pauseReplay();
    for (const source of ["manual", "microphone", "replay"]) {
      $(`${source}-source`).hidden = source !== name;
      $(`${source}-tab`).classList.toggle("active", source === name);
      $(`${source}-tab`).setAttribute("aria-selected", String(source === name));
    }
    setMode(nextMode); log("source_selected", { source: nextMode });
  }
  function setupSpeech() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      $("speech-support").textContent = t("当前浏览器未提供语音识别。请使用粘贴文字，或换用支持此能力的浏览器。");
      $("start-speech").disabled = true; return;
    }
    $("speech-support").textContent = t("检测到浏览器语音识别能力。需麦克风权限和可用的语音服务；仅保存最终识别结果。");
    speech = new Recognition(); speech.lang = window.MeetingI18n.speechLanguage; speech.continuous = true; speech.interimResults = true;
    const recognizer = speech;
    const current = () => speech === recognizer && speechWanted && speechGeneration === sessionGeneration && sessionRunning();
    let speechQueue = Promise.resolve();
    speech.onstart = () => { if (!current()) { try { recognizer.abort ? recognizer.abort() : recognizer.stop(); } catch {} return; } speechActive = true; syncSessionControls(); $("speech-live").textContent = t("正在收听本机麦克风…"); setMode("browser_mic"); log("microphone_start"); };
    speech.onresult = (event) => {
      if (!current()) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i], text = result[0].transcript.trim();
        if (result.isFinal && text) {
          const generation = sessionGeneration, meetingId = state?.meetingId, serverGeneration = state?.session?.generation, speaker = $("speaker-name").value.trim() || t("麦克风（说话人未区分）");
          speechQueue = speechQueue.then(async () => {
            if (generation !== sessionGeneration || !current()) return;
            const next = await api("/api/utterances", "POST", { speaker, text, source: "browser_mic", meetingId, sessionGeneration: serverGeneration });
            if (generation === sessionGeneration) acceptState(next);
          }).catch((error) => { if (generation === sessionGeneration) fail(error); });
        } else interim += text;
      }
      $("speech-live").textContent = interim || t("等待下一句…");
    };
    speech.onerror = (event) => {
      if (speech !== recognizer) return;
      speechWanted = false;
      const messages = { "not-allowed": t("麦克风或语音识别权限被拒绝。请检查浏览器权限，或改用粘贴文字。"), "audio-capture": t("没有可用的麦克风。"), network: t("浏览器语音服务连接失败，请改用粘贴文字。"), "no-speech": t("暂未检测到语音，可重新开始转写。") };
      $("speech-live").textContent = messages[event.error] || t`语音识别停止（${event.error}），可以改用粘贴文字。`;
      log("microphone_error", { error: event.error });
      syncSessionControls(); updateMonitor();
    };
    speech.onend = () => { if (speech !== recognizer) return; speechActive = false; speechWanted = false; speech = null; syncSessionControls(); if (mode === "browser_mic") setMode("browser_mic"); log("microphone_end"); };
  }
  function stopSpeech() {
    speechWanted = false;
    const old = speech; speech = null; speechActive = false;
    if (old) {
      old.onstart = old.onresult = old.onerror = old.onend = null;
      try { old.abort ? old.abort() : old.stop(); } catch { /* Already ended or waiting for permission. */ }
      $("speech-live").textContent = t("已停止麦克风转写。");
    }
    syncSessionControls();
    updateMonitor();
  }
  function pauseReplay() {
    if (replayRunning) { replaySeconds += (performance.now() - replayLastTick) / 1000 * Number($("replay-speed").value); replayRunning = false; }
    $("start-replay").disabled = !sessionRunning() || !replay || replayIndex >= replay.utterances.length;
    $("stop-replay").disabled = true;
    if (mode === "rehearsal") setMode("rehearsal");
  }
  async function loadReplay() {
    if (!state || resetting || sessionTransition) return;
    pauseReplay(); stopSpeech();
    if (state?.utterances?.length && !window.confirm(t("载入演练将开始一个新会话并清空当前记录。请先导出需要保留的日志。继续吗？"))) return;
    let generation = sessionGeneration, meetingId = state.meetingId;
    const current = () => generation === sessionGeneration && meetingId === state?.meetingId && !resetting && !sessionTransition;
    $("load-replay").disabled = true;
    try {
      const data = await api(`/api/rehearsal?lang=${window.MeetingI18n.language}`);
      if (!current()) return;
      if (!Array.isArray(data.utterances)) throw new Error(t("演练素材缺少发言列表。"));
      await saveProfile();
      if (!current()) return;
      if (state?.utterances?.length) {
        if (!await resetSession(false)) return;
        generation = sessionGeneration; meetingId = state.meetingId;
      }
      const roleIndex = Math.max(0, (data.roles || []).findIndex((role) => /部分参与者|partial participant/i.test(role.role)));
      const role = data.roles?.[roleIndex];
      if (role) {
        const next = await api("/api/profile", "POST", { ...role, language: window.MeetingI18n.language, meetingId, sessionGeneration: state.session.generation });
        if (!current()) return;
        acceptState(next); fillProfile(state.profile);
      }
      if (!current()) return;
      replay = data; replayIndex = 0; replaySeconds = 0;
      $("replay-role").replaceChildren(...(data.roles || []).map((role, index) => { const option = el("option", "", `${role.name} · ${role.role}`); option.value = index; return option; }));
      $("replay-role").value = String(roleIndex); $("replay-role").disabled = !(data.roles?.length);
      $("replay-progress").textContent = t`${data.title || t("演练")} · 共 ${data.utterances.length} 段 · 已载入演练角色`;
      $("start-replay").disabled = !sessionRunning() || !data.utterances.length;
      $("start-replay").textContent = t("开始回放");
      selectSource("replay"); log("rehearsal_loaded", { title: data.title });
      syncSessionControls(); toast(t("已载入演练。请先开始会话，再播放剧本；自动分析仍由你选择开启。"));
    } catch (error) { if (current()) fail(error); } finally { $("load-replay").disabled = false; }
  }
  async function tickReplay() {
    if (!sessionRunning() || !replayRunning || !replay || replayBusy) return;
    const now = performance.now();
    replaySeconds += (now - replayLastTick) / 1000 * Number($("replay-speed").value); replayLastTick = now;
    replayBusy = true;
    const generation = sessionGeneration, meetingId = state?.meetingId, serverGeneration = state?.session?.generation, currentReplay = replay;
    try {
      while (replayRunning && currentReplay === replay && replayIndex < currentReplay.utterances.length && Number(currentReplay.utterances[replayIndex].atSeconds) <= replaySeconds) {
        const item = currentReplay.utterances[replayIndex];
        const sentIndex = replayIndex;
        const next = await api("/api/utterances", "POST", { speaker: item.speaker || t("未注明"), text: item.text, source: "rehearsal", meetingId, sessionGeneration: serverGeneration });
        if (generation !== sessionGeneration || currentReplay !== replay) return;
        acceptState(next);
        replayIndex = Math.max(replayIndex, sentIndex + 1);
      }
      $("replay-progress").textContent = t`${replay.title || t("演练")} · ${duration(replaySeconds)} · 已加入 ${replayIndex} / ${replay.utterances.length} 段`;
      if (replayIndex >= replay.utterances.length) { pauseReplay(); $("replay-progress").textContent += t(" · 已结束"); log("rehearsal_end"); }
    } catch (error) { if (generation === sessionGeneration) { pauseReplay(); fail(error); } } finally { replayBusy = false; }
  }
  function catchup(refresh = false) {
    const now = Date.now(), from = now - 60000;
    const items = (state?.utterances || []).filter((u) => { const at = new Date(u.at).getTime(); return at >= from && at <= now; });
    $("catchup-range").textContent = t`${timeLabel(from)} — ${timeLabel(now)} · ${items.length} 条。此处为快照，新发言需手动刷新。`;
    if (items.length) $("catchup-list").replaceChildren(...items.map(transcriptNode));
    else empty($("catchup-list"), t("最近 60 秒没有新记录"), t("更早的发言仍可在完整记录中查看。"), "“");
    if (!$("catchup-dialog").open) $("catchup-dialog").showModal();
    log(refresh ? "catchup_refresh" : "catchup_open", { from: new Date(from).toISOString(), to: new Date(now).toISOString(), source_ids: items.map((u) => u.id) });
  }
  async function resetSession(ask = true) {
    if (resetting || sessionTransition) return false;
    if (ask && !window.confirm(t("重新开始会清空本次发言、提醒和操作记录，保留角色设置。请先导出需要保留的日志。确定继续吗？"))) return false;
    resetting = true; stopLocalActivity(); broadcastSession(); syncSessionControls();
    try {
      await saveProfile();
      const oldMeetingId = state?.meetingId;
      const next = await api("/api/reset", "POST", {});
      if (oldMeetingId) retiredMeetings.add(oldMeetingId);
      drafts.clear(); openAlertId = null; if ($("alert-dialog").open) $("alert-dialog").close(); if ($("catchup-dialog").open) $("catchup-dialog").close();
      replay = null; replayIndex = 0; replaySeconds = 0; lastAutoAttempt = ""; clientEvents.length = 0;
      $("replay-role").disabled = true;
      $("start-replay").disabled = true; $("stop-replay").disabled = true; $("replay-progress").textContent = t("尚未载入演练");
      $("analysis-error").hidden = true; $("analysis-status").textContent = t("新会话已准备好，请点击开始会话。");
      acceptState(next, true); log("session_reset"); return true;
    } finally { resetting = false; render(); broadcastSession(); }
  }
  function updateClock() {
    const session = state?.session;
    const activeMs = session?.status === "running" && session.activeSince ? Math.max(0, Date.now() - Date.parse(session.activeSince)) : 0;
    $("meeting-clock").textContent = duration(((session?.elapsedMs || 0) + activeMs) / 1000);
    updateMonitor();
  }
  async function poll() {
    if (pollBusy || resetting) return;
    pollBusy = true;
    const generation = sessionGeneration;
    try {
      const next = await api("/api/state");
      if (!resetting && generation === sessionGeneration) acceptState(next);
      $("connection-state").textContent = service?.keyConfigured ? t("本机服务已连接") : t("服务已连接 · 待配置 API");
      $("connection-state").className = "connection connected";
    } catch {
      $("connection-state").textContent = t("本机服务未连接");
      $("connection-state").className = "connection failed";
    } finally { pollBusy = false; }
  }
  function bind() {
    window.addEventListener("meeting-language-changed", () => {
      // Language changes update labels and the next analysis, never clear meeting data.
      for (const labels of [CATEGORY, STATUS, REASONS, SOURCES]) {
        for (const key of Object.keys(labels)) labels[key] = window.MeetingI18n.retranslate(labels[key]);
      }
      systemAudioInput = window.MeetingI18n.retranslate(systemAudioInput);
      for (const id of ["analysis-status", "analysis-error", "role-save-state", "copy-status", "speech-support", "speech-live", "replay-progress", "toast", "model-label", "connection-state"]) {
        const node = $(id); if (node) node.textContent = window.MeetingI18n.retranslate(node.textContent);
      }
      if (speech && !speechActive && !speechWanted) speech.lang = window.MeetingI18n.speechLanguage;
      render(); setMode(mode);
      if (state) { profileDirty = true; profileVersion++; saveProfile().catch(fail); }
    });
    $("start-session").addEventListener("click", () => changeSession("start"));
    $("stop-session").addEventListener("click", () => changeSession("stop"));
    window.addEventListener("meeting-system-audio-starting", event => { systemAudioInput = event.detail?.sourceLabel || t("会议声音＋麦克风"); systemAudioPending = true; systemAudioActive = false; stopSpeech(); pauseReplay(); setMode("browser_mixed"); });
    window.addEventListener("meeting-audio-mode", (event) => {
      systemAudioActive = Boolean(event.detail?.active); systemAudioPending = false;
      if (event.detail?.sourceLabel) systemAudioInput = event.detail.sourceLabel;
      if (event.detail?.active) {
        setMode("browser_mixed");
        if (event.detail.text) $("input-mode").textContent = event.detail.text;
      } else if (!$("microphone-source").hidden) {
        setMode("browser_mic");
      } else if (mode === "browser_mixed") {
        setMode(!$("replay-source").hidden ? "rehearsal" : "manual");
      }
      updateMonitor();
    });
    for (const field of ["user-name", "user-role", "user-responsibilities", "user-context"]) $(field).addEventListener("input", () => {
      profileDirty = true; profileVersion++; clearTimeout(profileTimer);
      if (openAlertId) updateDialog(false);
      $("role-save-state").textContent = t("有修改待保存"); profileTimer = setTimeout(() => saveProfile().catch(fail), 650);
      lastAutoAttempt = ""; autoPendingSince = 0; lastTextAt = Date.now();
      syncAnalysisControls(); scheduleAuto(); updateMonitor();
    });
    for (const source of ["manual", "microphone", "replay"]) $(`${source}-tab`).addEventListener("click", () => selectSource(source));
    $("add-transcript").addEventListener("click", addManual);
    $("transcript-input").addEventListener("input", syncAnalysisControls);
    $("transcript-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addManual(); } });
    $("analyze-button").addEventListener("click", () => analyze(false));
    $("analysis-next-step").addEventListener("click", () => {
      const action = $("analysis-next-step").dataset.action;
      if (action === "start") changeSession("start");
      else if (action === "add") addManual();
      else if (action === "profile") {
        const target = !$("user-name").value.trim() ? $("user-name") : $("user-responsibilities");
        target.scrollIntoView({ behavior: "smooth", block: "center" }); target.focus({ preventScroll: true });
      } else if (action === "input") {
        $("manual-tab").scrollIntoView({ behavior: "smooth", block: "center" });
        if (!$("manual-source").hidden) $("transcript-input").focus({ preventScroll: true });
      }
    });
    $("auto-analyze").addEventListener("change", () => {
      log("auto_analysis_toggle", { enabled: $("auto-analyze").checked });
      $("analysis-status").textContent = $("auto-analyze").checked ? t("已开启：新文字停顿 4 秒或累计等待 12 秒后自动提交，前一次完成后再处理下一批。") : t("自动分析已关闭；可手动点击分析。");
      lastAutoAttempt = ""; autoPendingSince = 0;
      lastTextAt = Date.now(); syncAnalysisControls(); scheduleAuto(); updateMonitor();
    });
    document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === button)); render();
    }));
    $("reply-draft").addEventListener("input", () => { if (openAlertId) drafts.set(openAlertId, $("reply-draft").value); $("copy-status").textContent = ""; updateDialog(false); });
    $("copy-reply").addEventListener("click", async () => {
      const text = $("reply-draft").value.trim(), alertId = openAlertId;
      if (!text) { $("copy-status").textContent = t("请先填写回复。"); return; }
      $("copy-reply").disabled = true;
      try {
        await action("confirm", { text }, alertId);
        if (!navigator.clipboard?.writeText) throw new Error(t("当前浏览器不支持剪贴板写入。草稿已确认，请手动选择复制；系统未记录复制成功。"));
        await navigator.clipboard.writeText(text);
        $("copy-status").textContent = t("已复制。请在腾讯会议中粘贴并自行发送。");
        try { await action("copy", { text }, alertId); } catch (error) { $("copy-status").textContent = t`已复制，但复制日志保存失败：${error.message}`; }
      } catch (error) { $("copy-status").textContent = `${error.message || t("复制失败")}${error.name === "NotAllowedError" ? t("。草稿已确认，剪贴板权限未获允许；未记录复制成功。") : ""}`; }
      finally { updateDialog(false); }
    });
    $("mark-sent").addEventListener("click", async () => {
      const alert = activeAlert();
      if (!alert?.confirmedText || $("reply-draft").value.trim() !== alert.confirmedText.trim()) { toast(t("请先确认当前草稿。")); return; }
      try { await action("mark_sent"); $("copy-status").textContent = t("已记录你的发送声明；助手无法核实腾讯会议中的实际发送结果。"); } catch (error) { fail(error); }
    });
    $("snooze-alert").addEventListener("click", () => action("defer").then(() => toast(t("已标记稍后处理，仍保留在列表中。"))).catch(fail));
    $("mark-not-needed").addEventListener("click", () => {
      const reason = $("not-needed-reason").value;
      if (!reason) { toast(t("先选择无需回应的原因。")); return; }
      action("not_needed", { reason }).then(() => toast(t("已标记无需回应，随时可以恢复。"))).catch(fail);
    });
    $("restore-alert").addEventListener("click", () => action("restore").then(() => toast(t("已恢复为待处理。"))).catch(fail));
    $("close-alert-dialog").addEventListener("click", () => $("alert-dialog").close());
    $("alert-dialog").addEventListener("close", () => { log("alert_close", { alertId: openAlertId }); openAlertId = null; });
    $("catchup-button").addEventListener("click", () => catchup(false)); $("refresh-catchup").addEventListener("click", () => catchup(true));
    for (const id of ["close-catchup", "done-catchup"]) $(id).addEventListener("click", () => $("catchup-dialog").close());
    $("catchup-dialog").addEventListener("close", () => log("catchup_close"));
    $("start-speech").addEventListener("click", () => {
      if (!sessionRunning() || speechActive || speechWanted) return;
      if (!speech) setupSpeech();
      if (!speech) return;
      window.dispatchEvent(new CustomEvent("meeting-stop-system-audio"));
      pauseReplay(); speechWanted = true; speechGeneration = sessionGeneration;
      syncSessionControls(); updateMonitor();
      try { speech.lang = window.MeetingI18n.speechLanguage; speech.start(); } catch (error) { speechWanted = false; $("speech-live").textContent = t`无法开始转写：${error.message}`; }
      syncSessionControls(); updateMonitor();
    });
    $("stop-speech").addEventListener("click", stopSpeech);
    $("load-replay").addEventListener("click", loadReplay);
    $("replay-role").addEventListener("change", async () => {
      const role = replay?.roles?.[Number($("replay-role").value)];
      if (!role) return;
      try { await saveProfile(); acceptState(await api("/api/profile", "POST", { ...role, language: window.MeetingI18n.language })); fillProfile(state.profile); toast(t`演练角色已切换为${role.name}，用于下一次分析。`); } catch (error) { fail(error); }
    });
    $("start-replay").addEventListener("click", () => {
      if (!sessionRunning() || !replay || replayIndex >= replay.utterances.length) return;
      replayRunning = true; replayLastTick = performance.now(); $("start-replay").disabled = true; $("start-replay").textContent = t("继续回放"); $("stop-replay").disabled = false; setMode("rehearsal"); log("rehearsal_start", { speed: Number($("replay-speed").value) }); tickReplay();
    });
    $("stop-replay").addEventListener("click", () => { pauseReplay(); log("rehearsal_pause"); });
    $("replay-speed").addEventListener("change", () => { if (replayRunning) replayLastTick = performance.now(); log("rehearsal_speed", { speed: Number($("replay-speed").value) }); });
    $("reset-meeting").addEventListener("click", () => resetSession(true).then((changed) => { if (changed) toast(t("已创建新会话；点击开始后计时。")); }).catch(fail));
    $("export-log").addEventListener("click", async () => {
      try {
        const data = await api("/api/export");
        const exported = { ...data, browserEvents: [...clientEvents], browserExportedAt: new Date().toISOString(), browserNote: t("copy 仅在剪贴板写入成功后记录；mark_sent 为用户声明，未验证会议平台实际发送。") };
        const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `meeting-assistant-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(t("日志已交给浏览器下载。"));
      } catch (error) { fail(error); }
    });
    window.addEventListener("beforeunload", () => { stopLocalActivity(); });
  }
  async function init() {
    bind(); setupSpeech(); setMode("manual");
    try {
      service = await api("/api/status");
      $("model-label").textContent = t`DeepSeek · ${service.model || t("以服务配置为准")} · 本地助手 ${service.version || ""}`;
      if (!service.keyConfigured) $("analysis-status").textContent = t("本机服务尚未配置 API 密钥。可先输入或回放内容；配置后再分析。");
    } catch { $("analysis-status").textContent = t("正在等待本机服务。请通过启动脚本打开此页面。"); }
    await poll();
    if (state && state.profile?.language !== window.MeetingI18n.language) { profileDirty = true; profileVersion++; await saveProfile().catch(fail); }
    setInterval(poll, 2000); setInterval(updateClock, 1000); setInterval(tickReplay, 200);
  }
  init();
})();
