"use strict";

// Experimental browser ASR over a mixed audio track. No video is read or uploaded.
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
  // These labels begin in HTML; own them here too once runtime updates replace their text nodes.
  tr("当前未接入会议声音。", "Meeting audio is not connected.");
  tr("实验入口尚未启动。", "Experimental capture has not started.");
  function refreshText(node) {
    if (!node) return;
    const next = translateCurrent(node.textContent);
    // Preserve static i18n bindings when no text actually changed.
    if (next !== node.textContent) node.textContent = next;
  }
  const startButton = document.getElementById("system-audio-start");
  const stopButton = document.getElementById("system-audio-stop");
  const status = document.getElementById("system-audio-status");
  const overview = document.getElementById("monitor-audio-feedback");
  const sourceSelect = document.getElementById("meeting-audio-source");
  const microphoneOption = document.getElementById("meeting-audio-microphone");
  const sourceHelp = document.getElementById("audio-source-help");
  const steps = document.getElementById("system-audio-steps");
  const captureRange = document.getElementById("audio-capture-range");
  const scopeConfirmation = document.getElementById("window-audio-confirmation");
  const confirmWindow = document.getElementById("confirm-window-audio");
  const cancelWindow = document.getElementById("cancel-window-audio");
  if (!startButton || !stopButton || !status) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let generation = 0, display = null, microphone = null, mixed = null, context = null, recognizer = null;
  let pending = false, active = false, queue = Promise.resolve();
  let restartTimer = null, recentEnds = [];
  let resolveScope = null, sourceLabel = tr("会议声音＋麦克风", "Meeting audio + microphone");
  let session = { running: false, generation: null, meetingId: null };

  function show(text, state = "idle") {
    status.textContent = text;
    status.dataset.state = state;
    if (overview) {
      overview.textContent = text;
      overview.dataset.state = state;
      overview.hidden = state === "idle";
    }
    updateButtons();
  }
  function updateButtons() {
    startButton.disabled = !session.running || pending || active;
    stopButton.disabled = !pending && !active;
    if (sourceSelect) sourceSelect.disabled = pending || active;
    if (microphoneOption) microphoneOption.disabled = pending || active;
    startButton.textContent = pending ? tr("正在开启…", "Starting…") : status.dataset.state === "error" ? tr("重试会议声音转写", "Retry meeting transcription") : tr("开始会议声音转写", "Start meeting transcription");
  }
  function matchesSession(expected) {
    return session.running && expected.meetingId === session.meetingId && expected.generation === session.generation;
  }
  function verifyServerSession(meeting, expected) {
    if (!matchesSession(expected) || meeting.meetingId !== expected.meetingId ||
        meeting.session?.status !== "running" || meeting.session.generation !== expected.generation) {
      throw new Error(tr("会议已停止或已切换，请在开始或继续会议后重新开启声音转写。", "The session stopped or changed. Start or resume it, then restart transcription."));
    }
  }
  function mode(text = tr("会议声音转写已停止", "Meeting transcription stopped")) {
    window.dispatchEvent(new CustomEvent("meeting-audio-mode", { detail: { active, text, sourceLabel } }));
  }
  function updateSourceHelp() {
    const windowOnly = sourceSelect?.value === "window", includeMic = microphoneOption?.checked !== false;
    if (sourceHelp) sourceHelp.textContent = windowOnly ?
      tr("请在共享框中选择腾讯会议的窗口，并选择“此应用的音频”。不同浏览器提供的选项可能不同；若只有系统音频，请取消。应用音频范围也可能包含同一应用的其他窗口。", "Choose the Tencent Meeting window and audio for that app in the sharing dialog. Options vary by browser. Cancel if only system audio is available. App audio may include other windows of the same app.") :
      tr("兼容模式接收全电脑的系统声音；浏览器视频、音乐和提示音等可能进入转写。需要排除其他应用时，改为指定应用窗口模式。", "Compatibility mode receives all computer audio, including videos, music and notifications. Choose a specific app window to exclude other apps.");
    if (steps) steps.innerHTML = `<li>${tr("点击开始，浏览器会弹出共享选择框。", "Click Start to open the browser sharing dialog.")}</li><li>${windowOnly ? tr("选择「窗口」中的腾讯会议，并选「此应用的音频」再共享。没有此选项时请取消，助手不会自动改成全电脑声音。", "Choose the Tencent Meeting window and audio for that app, then share. Cancel if app audio is unavailable; Meeting Cue will not switch to all computer audio.") : tr("选择「整个屏幕」并选中屏幕，打开「同时共享系统音频」再共享。", "Choose Entire screen, select a screen, enable sharing system audio, then share.")}</li><li>${includeMic ? tr("允许本机麦克风，", "Allow the local microphone. ") : tr("本次不接入麦克风，", "The microphone is excluded. ")}${tr("等显示「语音识别已启动」后，再让组员说一句完整的话。", "Wait for Speech recognition started, then ask a teammate to say a complete sentence.")}</li>`;
  }
  function stopTracks(stream) {
    for (const track of stream?.getTracks() || []) { track.onended = null; track.stop(); }
  }
  function stop(message, state = "idle") {
    const hadCapture = active || pending;
    generation += 1;
    pending = false; active = false;
    clearTimeout(restartTimer); restartTimer = null; recentEnds = [];
    if (scopeConfirmation) scopeConfirmation.hidden = true;
    if (resolveScope) { const resolve = resolveScope; resolveScope = null; resolve(false); }
    if (captureRange && hadCapture) captureRange.textContent = tr("会议声音接入已停止。", "Meeting audio capture stopped.");
    if (recognizer) {
      recognizer.onstart = recognizer.onresult = recognizer.onerror = recognizer.onend = null;
      try { recognizer.abort(); } catch { /* May already have ended. */ }
    }
    recognizer = null;
    stopTracks(display); stopTracks(microphone); stopTracks(mixed); display = microphone = mixed = null;
    if (context) {
      context.close().catch(() => {});
      context = null;
    }
    updateButtons();
    if (message) show(message, state);
    if (hadCapture) mode(message);
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { "Accept-Language": window.MeetingI18n?.language || "en", ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || tr("本机服务请求失败。", "The local service request failed."));
    return data;
  }
  async function start() {
    if (pending || active) return;
    if (!session.running) {
      show(tr("请先开始或继续会议，再开启会议声音转写。", "Start or resume the session before starting meeting transcription."));
      updateButtons();
      return;
    }
    // Older implementations can silently ignore the track argument and use the mic.
    // Restrict this experimental path to Chromium versions documenting audioTrack support.
    const windowOnly = sourceSelect?.value === "window", includeMic = microphoneOption?.checked !== false;
    sourceLabel = windowOnly ? tr(`指定应用音频${includeMic ? "＋本机麦克风" : "（未收麦克风）"}`, `Selected app audio${includeMic ? " + local microphone" : " (microphone excluded)"}`) : includeMic ? tr("会议声音＋麦克风", "Meeting audio + microphone") : tr("全电脑声音（未收麦克风）", "All computer audio (microphone excluded)");
    const chromium = navigator.userAgent.match(/(?:Chrome|Edg)\/(\d+)/);
    if (!Recognition || !navigator.mediaDevices?.getDisplayMedia ||
        (includeMic && !navigator.mediaDevices?.getUserMedia) || !window.AudioContext ||
        !chromium || Number(chromium[1]) < 135) {
      show(tr("此入口需要支持音轨识别的桌面 Chrome / Edge 135+。请改用文字输入，或在兼容浏览器中实测。", "This option requires desktop Chrome / Edge 135+ with audio-track recognition. Use text input or test in a compatible browser."), "error");
      return;
    }
    const token = ++generation;
    const expectedSession = { ...session };
    pending = true; updateButtons();
    window.dispatchEvent(new CustomEvent("meeting-system-audio-starting", { detail: { sourceLabel } }));
    show(windowOnly ? tr("第 1/3 步：选择腾讯会议窗口，并选择「此应用的音频」。若只有系统音频选项，请取消。", "Step 1/3: Choose the Tencent Meeting window and audio for that app. Cancel if only system audio is offered.") : tr("第 1/3 步：在浏览器弹窗中选择「整个屏幕」，选中屏幕，打开「同时共享系统音频」再点「共享」。", "Step 1/3: In the browser dialog, choose Entire screen, select a screen, enable system audio, then click Share."), "pending");
    try {
      // Start both operations within the click handler: awaiting the HTTP request
      // before getDisplayMedia would lose the browser's transient user activation.
      // Capture rejection as data while the user is still answering the prompt.
      const startingState = request("/api/state").then(value => ({ value }), error => ({ error }));
      const captured = await navigator.mediaDevices.getDisplayMedia(windowOnly ? {
        video: { displaySurface: "window" }, audio: true, windowAudio: "window",
        systemAudio: "exclude", monitorTypeSurfaces: "exclude", surfaceSwitching: "exclude"
      } : {
        video: { displaySurface: "monitor" }, audio: true, systemAudio: "include"
      });
      if (token !== generation) { stopTracks(captured); return; }
      display = captured;
      const initial = await startingState;
      if (token !== generation) return;
      if (initial.error) throw initial.error;
      verifyServerSession(initial.value, expectedSession);
      const videoTrack = display.getVideoTracks?.()[0];
      if (windowOnly && videoTrack?.getSettings?.().displaySurface !== "window") {
        throw new Error(tr("本次没有选中应用窗口，已取消接入。请选择「窗口」中的腾讯会议；助手不会自动切换到全电脑声音。", "No app window was selected, so capture was cancelled. Choose the Tencent Meeting window. Capture will not switch to all computer audio."));
      }
      if (!display.getAudioTracks().length) {
        if (windowOnly) throw new Error(tr("浏览器没有为所选窗口提供音频，已取消接入。请检查是否支持「此应用的音频」；需要兼容模式时，请自行切换为全电脑声音。", "The browser did not provide audio for the selected window, so capture was cancelled. Check app-audio support or manually choose all computer audio."));
        const surface = display.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
        const selected = surface === "window" ? tr("这次选择的是应用窗口，但浏览器没有提供它的声音。", "An app window was selected, but the browser did not provide its audio. ") :
          surface === "browser" ? tr("这次选择的是浏览器标签页，未取得音频。腾讯会议桌面版的声音需从系统音频接入。", "A browser tab was selected without audio. Tencent Meeting desktop audio requires app or system audio capture. ") : tr("本次共享只提供了画面，没有音频。", "The selected share provided video only, without audio. ");
        throw new Error(tr(`没有取得系统音频。${selected}已结束此次共享。请点「重试会议声音转写」，选择「整个屏幕」并开启「同时共享系统音频」。若没有音频开关，可换桌面 Chrome 重试或暂用文字输入。`, `No system audio received. ${selected}Sharing has ended. Retry meeting transcription, choose Entire screen and enable system audio. If unavailable, try desktop Chrome or use text input.`));
      }
      for (const track of display.getTracks()) {
        track.onended = () => { if (token === generation) stop(tr("屏幕或系统音频共享已结束，转写已停止。", "Screen or system audio sharing ended. Transcription stopped.")); };
      }
      if (windowOnly) {
        if (!scopeConfirmation || !confirmWindow || !cancelWindow) throw new Error(tr("当前页面缺少应用音频范围确认入口，请刷新后重试。", "The app-audio confirmation control is missing. Refresh and try again."));
        if (captureRange) captureRange.textContent = tr(`已选窗口：${videoTrack.label || "应用窗口"}。尚未确认声音范围，未开始转写。`, `Selected window: ${videoTrack.label || "App window"}. Audio scope is not yet confirmed; transcription has not started.`);
        scopeConfirmation.hidden = false;
        show(tr("请在下方确认刚才选的是「此应用的音频」。选择了窗口画面，并不能证明声音已隔离。", "Confirm below that you selected audio for this app. Selecting a window picture alone does not prove audio isolation."), "pending");
        const confirmed = await new Promise(resolve => { resolveScope = resolve; });
        if (token !== generation) return;
        if (!confirmed) { stop(tr("未确认应用音频范围，接入已取消。", "The app-audio scope was not confirmed. Capture cancelled.")); return; }
        const afterConfirmation = await request("/api/state");
        if (token !== generation) return;
        verifyServerSession(afterConfirmation, expectedSession);
      }
      if (captureRange) captureRange.textContent = windowOnly ?
        tr(`当前范围：所选应用${includeMic ? "＋本机麦克风" : "；未收麦克风"}（按你在共享框中的应用音频选择，隔离仍需实测）。`, `Capture scope: selected app${includeMic ? " + local microphone" : "; microphone excluded"}. Based on your app-audio selection; isolation still needs testing.`) :
        tr(`当前范围：全电脑系统声音${includeMic ? "＋本机麦克风" : "；未收麦克风"}。其他应用的声音可能进入转写。`, `Capture scope: all computer audio${includeMic ? " + local microphone" : "; microphone excluded"}. Other apps may enter the transcript.`);
      show(includeMic ? tr("第 2/3 步：已取得会议声音，正在等待麦克风权限；若出现权限提示，请选择允许。", "Step 2/3: Meeting audio received. Waiting for microphone permission; allow it if prompted.") : tr("第 2/3 步：已取得所选音频；本次不接入麦克风，正在准备转写。", "Step 2/3: Selected audio received. The microphone is excluded. Preparing transcription."), "pending");
      if (includeMic) {
        const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }, video: false
        });
        if (token !== generation) { stopTracks(mic); return; }
        microphone = mic;
        for (const track of microphone.getTracks()) {
          track.onended = () => { if (token === generation) stop(tr("麦克风连接已结束，会议声音转写已停止。", "The microphone disconnected. Meeting transcription stopped.")); };
        }
      }
      const meeting = await request("/api/state");
      if (token !== generation) return;
      verifyServerSession(meeting, expectedSession);
      const meetingId = meeting.meetingId;
      const sessionGeneration = meeting.session.generation;
      // Edge 155 returned empty/misrecognized results for a default 48 kHz
      // Web Audio track. Real synthetic-speech probes recognized the same
      // Chinese audio at 16 kHz. Resample both inputs before passing to ASR.
      context = new window.AudioContext({ sampleRate: 16000 });
      const mix = context.createMediaStreamDestination();
      mix.channelCount = 1;
      mixed = mix.stream;
      context.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(mix);
      if (microphone) context.createMediaStreamSource(microphone).connect(mix);
      await context.resume();
      if (token !== generation) return;
      const audioTrack = mix.stream.getAudioTracks()[0];
      if (!audioTrack || audioTrack.readyState !== "live") throw new Error(tr("混合音轨不可用，请改用文字输入。", "The mixed audio track is unavailable. Use text input."));
      show(tr("第 3/3 步：声音已接入，正在启动浏览器语音识别；尚未开始生成文字。", "Step 3/3: Audio connected. Starting browser speech recognition; no transcript has been produced yet."), "pending");
      recognizer = new Recognition();
      let networkRetries = 0, retryingNetwork = false;
      const resumeRecognition = (message, delay) => {
        clearTimeout(restartTimer);
        show(message, "pending");
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (token !== generation || !matchesSession(expectedSession)) return;
          try { recognizer.lang = window.MeetingI18n?.speechLanguage || "en-US"; recognizer.start(audioTrack); }
          catch (error) { stop(tr(`自动继续转写失败：${error.message || "请重试。"}`, `Could not resume transcription: ${error.message || "Please retry."}`), "error"); }
        }, delay);
      };
      recognizer.lang = window.MeetingI18n?.speechLanguage || "en-US"; recognizer.continuous = true; recognizer.interimResults = true;
      recognizer.onstart = () => {
        if (token !== generation || !matchesSession(expectedSession)) return;
        retryingNetwork = false;
        pending = false; active = true;
        updateButtons();
        show(tr("语音识别已启动。请让组员说一句完整的话，再核对下方发言记录；启动成功还不代表已经识别到组员的声音。", "Speech recognition started. Ask a teammate to say a complete sentence, then check the transcript below. Starting alone does not confirm successful recognition."), "active");
        mode(tr(`${sourceLabel} · 采集中（实验）`, `${sourceLabel} · Capturing (experimental)`));
      };
      recognizer.onresult = event => {
        if (token !== generation || !matchesSession(expectedSession)) return;
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i], text = result[0].transcript.trim();
          if (!result.isFinal) { interim += text; continue; }
          if (!text) continue;
          networkRetries = 0;
          queue = queue.then(async () => {
            if (token !== generation || !matchesSession(expectedSession)) return;
            if (text.length > 4000) throw new Error(tr("单次转写过长，请分段发言或改为手动分段输入。", "This transcript segment is too long. Speak in shorter sections or enter shorter text segments."));
            await request("/api/utterances", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ meetingId, sessionGeneration, speaker: tr(`${windowOnly ? "所选应用音频" : "会议混合音频"}（说话人未区分）`, `${windowOnly ? "Selected app audio" : "Mixed meeting audio"} (speaker not identified)`), text, source: "browser_mixed" })
            });
          }).catch(error => {
            if (token === generation) stop(tr(`转写未能保存：${error.message}`, `Transcript could not be saved: ${error.message}`), "error");
          });
        }
        show(interim || tr(`正在收听${sourceLabel}；已完成的句子会出现在发言列表。`, `Listening to ${sourceLabel}. Completed sentences appear in the transcript.`), "active");
      };
      recognizer.onerror = event => {
        if (token !== generation) return;
        if (event.error === "network" && matchesSession(expectedSession) && audioTrack.readyState === "live" && networkRetries < 2) {
          networkRetries += 1; retryingNetwork = true;
          resumeRecognition(tr(`语音服务连接短暂中断，正在自动重连（${networkRetries}/2）；已保存的文字仍保留。点击停止可取消。`, `Speech connection interrupted. Reconnecting (${networkRetries}/2); saved text is retained. Click Stop to cancel.`), 1000);
          return;
        }
        const messages = {
          network: tr("浏览器语音服务连接失败，自动重连仍未恢复。已保存的文字仍保留；请重试或改用文字输入。", "Browser speech service connection failed after retries. Saved text is retained. Retry or use text input."),
          "not-allowed": tr("浏览器拒绝了音频识别权限，请检查权限后重试。", "The browser denied speech recognition permission. Check permissions and retry."),
          "service-not-allowed": tr("当前浏览器的语音服务不可用，请改用文字输入。", "This browser speech service is unavailable. Use text input."),
          "audio-capture": tr("语音服务无法使用混合音轨，请改用文字输入。", "The speech service cannot use the mixed audio track. Use text input."),
          "no-speech": tr("暂未检测到语音，采集已停止；可重新开始。", "No speech detected. Capture stopped; you can restart it.")
        };
        stop(messages[event.error] || tr(`语音服务已停止（${event.error || "未知错误"}），可改用文字输入。`, `Speech service stopped (${event.error || "Unknown error"}). Use text input.`), "error");
      };
      recognizer.onend = () => {
        if (token !== generation || !matchesSession(expectedSession)) return;
        if (retryingNetwork || restartTimer !== null) return;
        // A normal end after silence is not a request to stop the meeting.
        // Keep the existing capture tracks and resume ASR, without new permissions.
        if (!active || audioTrack.readyState !== "live") {
          stop(tr("语音识别未能持续启动，采集已停止。请重试。", "Speech recognition did not stay active. Capture stopped. Please retry."), "error"); return;
        }
        const now = Date.now();
        recentEnds = recentEnds.filter(at => now - at < 30000);
        if (recentEnds.length >= 3) {
          stop(tr("语音服务在短时间内反复结束，已停止采集。请重试会议声音转写。", "Speech recognition ended repeatedly in a short period. Capture stopped. Retry meeting transcription."), "error"); return;
        }
        recentEnds.push(now);
        resumeRecognition(tr("浏览器本轮识别已结束，正在自动继续；会议声音仍已接入。点击停止可结束采集。", "This recognition segment ended. Resuming automatically with the same meeting audio. Click Stop to end capture."), 400);
      };
      // Never fall back to start() here: it would silently capture only the mic.
      recognizer.start(audioTrack);
    } catch (error) {
      if (token !== generation) return;
      if (windowOnly && error.name === "TypeError") {
        stop(tr("当前浏览器不支持此次指定应用音频请求，接入已取消。请检查浏览器的应用音频支持；需要兼容模式时，请手动切换为全电脑声音。", "This browser does not support the requested app audio. Capture cancelled. Check app-audio support or manually choose all computer audio."), "error");
        return;
      }
      stop(error.name === "NotAllowedError" ? tr("未授权屏幕音频或麦克风，采集已停止。可重新开始或改用文字输入。", "Screen audio or microphone permission was not granted. Capture stopped. Restart or use text input.") :
        tr(`会议声音输入未启动：${error.message || "请检查浏览器权限和兼容性。"}`, `Meeting audio did not start: ${error.message || "Check browser permissions and compatibility."}`), "error");
    }
  }
  startButton.addEventListener("click", start);
  sourceSelect?.addEventListener("change", updateSourceHelp);
  microphoneOption?.addEventListener("change", updateSourceHelp);
  confirmWindow?.addEventListener("click", () => {
    if (!resolveScope) return;
    const resolve = resolveScope; resolveScope = null; scopeConfirmation.hidden = true; resolve(true);
  });
  cancelWindow?.addEventListener("click", () => stop(tr("已取消应用音频接入，未开始转写。", "App-audio capture cancelled. Transcription did not start.")));
  stopButton.addEventListener("click", () => stop(tr("会议声音转写已停止。", "Meeting transcription stopped.")));
  window.addEventListener("meeting-stop-system-audio", () => stop(tr("会议声音转写已停止。", "Meeting transcription stopped.")));
  window.addEventListener("meeting-session-state", event => {
    const detail = event.detail || {};
    const next = {
      running: detail.running === true && Number.isSafeInteger(detail.generation) && typeof detail.meetingId === "string" && !!detail.meetingId,
      generation: detail.generation, meetingId: detail.meetingId
    };
    const changed = next.generation !== session.generation || next.meetingId !== session.meetingId || next.running !== session.running;
    session = next;
    if (!session.running || changed) {
      stop(session.running ? tr("会议已开始；需要采集时，请点击开始会议声音转写。", "Session started. Click Start meeting transcription when ready to capture audio.") : tr("会议未运行，声音采集已停止。请先开始或继续会议。", "The session is not running. Audio capture stopped. Start or resume the session first."));
    } else updateButtons();
  });
  window.addEventListener("beforeunload", () => stop());
  window.addEventListener("meeting-language-changed", () => {
    // Preserve the capture session and existing transcript; a natural restart picks up ASR language.
    sourceLabel = translateCurrent(sourceLabel);
    for (const node of [status, overview, captureRange]) refreshText(node);
    if (active && status.dataset.state === "active" && translations.has(status.textContent)) {
      show(tr(`正在收听${sourceLabel}；已完成的句子会出现在发言列表。`, `Listening to ${sourceLabel}. Completed sentences appear in the transcript.`), "active");
    }
    if (recognizer) recognizer.lang = window.MeetingI18n?.speechLanguage || "en-US";
    updateButtons(); updateSourceHelp();
    if (active) mode(status.textContent);
  });
  updateButtons();
  updateSourceHelp();
  refreshText(status); refreshText(captureRange);
})();
