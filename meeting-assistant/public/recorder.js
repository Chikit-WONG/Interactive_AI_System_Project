const t = (...args) => globalThis.MeetingI18n?.t(...args) ?? (Array.isArray(args[0]) ? args[0].reduce((s, part, i) => s + part + (args[i + 1] ?? ""), "") : args[0]);
// The recorder never posts or uploads audio/video. Only user-selected browser capture is used.
export function chooseWebmType(Recorder, withAudio = true) {
  if (typeof Recorder?.isTypeSupported !== "function") return "";
  const candidates = withAudio
    ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find((type) => Recorder.isTypeSupported(type)) || "";
}

export function recordingSupport(env = globalThis) {
  if (env.isSecureContext === false) return { ok: false, reason: t("请通过本机 localhost 或 HTTPS 打开此页。") };
  if (!env.navigator?.mediaDevices?.getDisplayMedia) return { ok: false, reason: t("当前浏览器没有屏幕共享接口，请换用支持屏幕录制的桌面浏览器。") };
  const mimeType = chooseWebmType(env.MediaRecorder);
  if (!mimeType) return { ok: false, reason: t("当前浏览器不支持此页需要的 WebM 录制，无法开始。") };
  return { ok: true, mimeType };
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() || []) {
    if (track.readyState !== "ended") track.stop();
  }
}

function permissionMessage(error) {
  if (error?.name === "NotAllowedError") return t("未获得屏幕或麦克风授权。没有开始录制，可调整选择后重试。");
  if (error?.name === "NotFoundError") return t("没有找到所需的画面或麦克风。可取消麦克风选项再试。");
  if (error?.name === "NotReadableError") return t("浏览器无法读取选定的画面或声音；请检查设备占用后重试。");
  return t("录制未启动：") + (error?.message || t("浏览器无法完成采集。"));
}

export class LocalRecorder {
  constructor(env = globalThis, onUpdate = () => {}) {
    this.env = env;
    this.onUpdate = onUpdate;
    this.state = "idle";
    this.message = t("准备好后点击开始；浏览器会让你选择画面。");
    this.audio = t("尚未开始采集");
    this.elapsedMs = 0;
    this.mimeType = "";
    this.blob = null;
    this.downloadRequested = false;
    this.current = null;
    this.timer = null;
  }
  snapshot() {
    return { state: this.state, message: this.message, audio: this.audio, elapsedMs: this.elapsedMs,
      mimeType: this.mimeType, blob: this.blob, downloadRequested: this.downloadRequested };
  }
  notify() { this.onUpdate(this.snapshot()); }
  active(session) { return this.current === session && !session.cancelled; }
  updateTime(session) {
    if (session.startedAt !== null) this.elapsedMs = Math.max(0, this.env.performance.now() - session.startedAt);
  }
  clearTimer() {
    if (this.timer !== null) this.env.clearInterval(this.timer);
    this.timer = null;
  }
  async release(session) {
    if (session.cleanup) return session.cleanup;
    // Stop each shared track once, including the destination's generated audio track.
    const tracks = new Set([session.display, session.microphone, session.mixed, session.recordStream]
      .flatMap((stream) => stream?.getTracks() || []));
    for (const track of tracks) if (track.readyState !== "ended") track.stop();
    for (const node of session.nodes) { try { node.disconnect(); } catch {} }
    session.cleanup = (async () => {
      if (session.context && session.context.state !== "closed") {
        try { await session.context.close(); } catch {}
      }
    })();
    return session.cleanup;
  }
  async start({ systemAudio = true, microphone = false } = {}) {
    if (["requesting", "recording", "finalizing"].includes(this.state)) return;
    const support = recordingSupport(this.env);
    if (!support.ok) { this.message = support.reason; this.notify(); return; }
    if (microphone && !this.env.navigator.mediaDevices.getUserMedia) {
      this.message = t("当前浏览器不支持麦克风采集。取消麦克风选项后可只录画面。"); this.notify(); return;
    }
    this.blob = null;
    this.downloadRequested = false;
    this.elapsedMs = 0;
    this.mimeType = "";
    this.audio = t("等待选择画面与声音");
    this.state = "requesting";
    this.message = t("请选择要录制的屏幕或窗口；录音是否可用以浏览器返回结果为准。");
    const session = { display: null, microphone: null, mixed: null, recordStream: null, context: null,
      recorder: null, nodes: [], chunks: [], startedAt: null, cancelled: false, finalized: false,
      cleanup: null, error: "", stoppedBy: "" };
    this.current = session;
    this.notify();
    try {
      // Invoke from the start button's user activation, before awaiting any other permission.
      const display = await this.env.navigator.mediaDevices.getDisplayMedia({
        video: true, audio: systemAudio, systemAudio: systemAudio ? "include" : "exclude"
      });
      if (!this.active(session)) { stopTracks(display); return; }
      session.display = display;
      const video = display.getVideoTracks()[0];
      if (!video || video.readyState === "ended") throw new Error(t("没有取得可用的画面轨道。"));
      video.addEventListener("ended", () => { if (this.active(session)) this.stop(t("屏幕共享已结束。")); });
      if (microphone) {
        const mic = await this.env.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
        if (!this.active(session)) { stopTracks(mic); return; }
        session.microphone = mic;
        if (!mic.getAudioTracks().some((t) => t.readyState === "live")) throw new Error(t("没有取得可用的麦克风音轨。"));
      }
      const sharedAudio = systemAudio ? display.getAudioTracks().filter((t) => t.readyState === "live") : [];
      if (!systemAudio) for (const track of display.getAudioTracks()) track.stop();
      const micAudio = session.microphone?.getAudioTracks().filter((t) => t.readyState === "live") || [];
      const audioTracks = [...sharedAudio, ...micAudio];
      for (const track of audioTracks) track.addEventListener("ended", () => { if (this.active(session)) this.stop(t("录入的声音轨道已断开。")); });
      let recordedAudio = audioTracks;
      if (audioTracks.length > 1) {
        const Context = this.env.AudioContext || this.env.webkitAudioContext;
        if (!Context) throw new Error(t("当前浏览器不能混合两路声音，请只选择一种声音来源。"));
        session.context = new Context();
        const destination = session.context.createMediaStreamDestination();
        session.mixed = destination.stream;
        session.nodes.push(destination);
        for (const track of audioTracks) {
          const source = session.context.createMediaStreamSource(new this.env.MediaStream([track]));
          source.connect(destination);
          session.nodes.push(source);
        }
        await session.context.resume();
        if (!this.active(session)) return;
        if (session.context.state !== "running") throw new Error(t("声音混合器未能启动，请重新开始或只选一种声音。"));
        recordedAudio = session.mixed.getAudioTracks();
      }
      if (!this.active(session)) return;
      if (video.readyState !== "live" || audioTracks.some((t) => t.readyState !== "live")) throw new Error(t("所选画面或声音已结束，请重新选择。"));
      this.mimeType = chooseWebmType(this.env.MediaRecorder, recordedAudio.length > 0);
      if (!this.mimeType) throw new Error(t("此浏览器不支持所需画面与声音组合的 WebM 编码。"));
      session.recordStream = new this.env.MediaStream([video, ...recordedAudio]);
      session.recorder = new this.env.MediaRecorder(session.recordStream, { mimeType: this.mimeType });
      if (session.recorder.mimeType && !session.recorder.mimeType.startsWith("video/webm")) throw new Error(t("浏览器未采用 WebM 编码。"));
      session.recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size > 0 && !session.finalized) session.chunks.push(event.data);
      });
      session.recorder.addEventListener("stop", () => { void this.finish(session); });
      session.recorder.addEventListener("error", (event) => {
        if (!this.active(session)) return;
        session.error = event.error?.message || t("浏览器录制中断");
        this.stop(t("录制遇到错误，正在收取已录片段。"));
      });
      session.recorder.start(1000);
      session.startedAt = this.env.performance.now();
      this.state = "recording";
      this.audio = (sharedAudio.length ? t("已取得共享音轨") : systemAudio ? t("未取得共享音轨") : t("未请求共享音轨"))
        + " · " + (micAudio.length ? t("已取得麦克风音轨") : t("未录麦克风"))
        + (recordedAudio.length ? t("（是否有声请停录后回放确认）") : t(" · 本次为无声录像"));
      this.message = t("正在录制。可切到腾讯会议和助手；完成后回到此页停止并保存。");
      this.timer = this.env.setInterval(() => { this.updateTime(session); this.notify(); }, 500);
      this.notify();
    } catch (error) {
      if (!this.active(session)) return;
      await this.release(session);
      if (this.current !== session) return;
      this.current = null;
      this.state = "idle";
      this.message = permissionMessage(error);
      this.audio = t("采集已停止");
      this.notify();
    }
  }
  stop(reason = t("已请求停止录制。")) {
    const session = this.current;
    if (!session || session.finalized) return;
    if (this.state === "requesting") {
      session.cancelled = true;
      this.current = null;
      void this.release(session);
      this.state = "idle";
      this.message = t("已取消开始。若浏览器授权框仍打开，请关闭它；迟到的采集结果也会立即释放。");
      this.audio = t("采集已停止");
      this.notify();
      return;
    }
    if (this.state === "finalizing") return;
    this.updateTime(session);
    this.clearTimer();
    this.state = "finalizing";
    session.stoppedBy = reason;
    this.message = reason + t(" 正在收取最后一段数据，请保留此页。");
    this.notify();
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } catch (error) {
      session.error = error.message || t("停止录制失败");
      this.message = t("停止录制遇到异常，已释放采集设备；仍在等待浏览器结束数据。");
      this.notify();
    }
    // Listeners stay attached: stop() supplies the final dataavailable before stop.
    void this.release(session);
  }
  async finish(session) {
    if (session.finalized || this.current !== session) return;
    session.finalized = true;
    if (this.state !== "finalizing") this.updateTime(session);
    this.clearTimer();
    this.state = "finalizing";
    this.message = t("正在整理最后一段数据…");
    this.notify();
    await this.release(session);
    if (this.current !== session) return;
    this.blob = new this.env.Blob(session.chunks, { type: session.recorder.mimeType || this.mimeType });
    this.current = null;
    if (this.blob.size > 0) {
      this.state = "ready";
      this.message = session.error ? t("录制曾中断。可保存已收到的片段，请回放检查完整性。")
        : t("录制已停止。可先回放检查，再保存到本机。");
    } else {
      this.blob = null;
      this.state = "idle";
      this.message = t("没有收到可保存的视频片段。") + (session.error ? t("浏览器报告：") + session.error + "。" : "")
        + t("请重新开始，并先做短录制检查。");
    }
    this.notify();
  }
  markDownloadRequested() {
    if (this.state !== "ready" || !this.blob?.size) return false;
    this.downloadRequested = true;
    this.message = t("已请求浏览器下载。请确认下载完成并能播放；本页仍保留视频，可再次保存。");
    this.notify();
    return true;
  }
  hasUnsavedWork() {
    return ["requesting", "recording", "finalizing"].includes(this.state)
      || Boolean(this.blob && !this.downloadRequested);
  }
  dispose() {
    const session = this.current;
    if (session) {
      this.stop();
      session.cancelled = true;
      this.current = null;
      void this.release(session);
      this.state = "idle";
      this.message = t("离开页面时已停止采集；此页没有自动保存录像。需要时可重新开始。");
      this.audio = t("采集已停止");
    }
    this.clearTimer();
    this.notify();
  }
}

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  return String(mins).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const support = recordingSupport();
  const preview = $("record-preview");
  let previewBlob = null;
  let videoUrl = "";
  function clearPreview() {
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
    preview.hidden = true;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = "";
    previewBlob = null;
  }
  $("record-capability").textContent = support.ok
    ? t("浏览器可用 WebM 编码已通过能力检查；实际录制仍需屏幕授权。")
    : support.reason;
  const recorder = new LocalRecorder(globalThis, (view) => {
    const busy = ["requesting", "recording", "finalizing"].includes(view.state);
    $("record-start").disabled = !support.ok || busy;
    $("record-stop").disabled = !["requesting", "recording"].includes(view.state);
    $("record-stop").textContent = view.state === "requesting" ? t("取消开始") : t("停止录制");
    $("record-save").disabled = view.state !== "ready" || !view.blob;
    $("record-system-audio").disabled = busy;
    $("record-microphone").disabled = busy;
    $("record-status").textContent = globalThis.MeetingI18n?.retranslate(view.message) ?? view.message;
    $("record-duration").textContent = formatDuration(view.elapsedMs);
    $("record-audio").textContent = globalThis.MeetingI18n?.retranslate(view.audio) ?? view.audio;
    if (view.blob && view.blob !== previewBlob) {
      clearPreview();
      previewBlob = view.blob;
      videoUrl = URL.createObjectURL(view.blob);
      preview.src = videoUrl;
      preview.hidden = false;
    } else if (!view.blob && previewBlob) clearPreview();
  });
  window.addEventListener("meeting-language-changed", () => {
    $("record-capability").textContent = globalThis.MeetingI18n.retranslate($("record-capability").textContent);
    recorder.notify();
  });
  recorder.notify();
  $("record-start").addEventListener("click", () => {
    if (recorder.blob && !window.confirm(t("重新录制会替换此页的视频。请确认上一段已下载；仍要继续吗？"))) return;
    clearPreview();
    void recorder.start({ systemAudio: $("record-system-audio").checked, microphone: $("record-microphone").checked });
  });
  $("record-stop").addEventListener("click", () => recorder.stop());
  $("record-save").addEventListener("click", () => {
    if (recorder.state !== "ready" || !videoUrl) return;
    const link = document.createElement("a");
    link.href = videoUrl;
    link.download = "meeting-cue-demo-" + new Date().toISOString().replace(/[:.]/g, "-") + ".webm";
    document.body.append(link);
    link.click();
    link.remove();
    recorder.markDownloadRequested();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!recorder.hasUnsavedWork()) return;
    event.preventDefault();
    event.returnValue = t("此页仍有尚未保存的录制内容。");
  });
  window.addEventListener("pagehide", () => { recorder.dispose(); clearPreview(); });
  window.addEventListener("pageshow", () => recorder.notify());
}
