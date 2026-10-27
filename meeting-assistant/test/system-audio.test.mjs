// Isolated lifecycle checks; no physical audio, browser speech service, .env,
// network access, or model calls. These tests do not establish ASR compatibility.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/system-audio.js", import.meta.url), "utf8");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return true;
  }
  click() { return this.dispatchEvent({ type: "click" }); }
}
class Element extends Events {
  constructor() {
    super();
    this.disabled = false; this.hidden = false; this.textContent = ""; this.className = ""; this.dataset = {}; this.attributes = new Map();
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      }
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}
class Track {
  constructor(kind, label, settings = {}) { this.kind = kind; this.label = label; this.settings = settings; this.readyState = "live"; this.stopCount = 0; this.onended = null; }
  stop() { this.stopCount++; this.readyState = "ended"; }
  getSettings() { return { ...this.settings }; }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
}
function harness(options = {}) {
  const elements = Object.fromEntries(["system-audio-start", "system-audio-stop", "system-audio-status"].map((id) => [id, Object.assign(new Element(), { disabled: id === "system-audio-stop" })]));
  for (const id of ["meeting-audio-source", "meeting-audio-microphone", "audio-source-help", "system-audio-steps", "audio-capture-range", "window-audio-confirmation", "confirm-window-audio", "cancel-window-audio"]) elements[id] = new Element();
  elements["meeting-audio-source"].value = options.source || "system";
  elements["meeting-audio-microphone"].checked = options.includeMic !== false;
  elements["window-audio-confirmation"].hidden = true;
  if (options.seedMarkup) {
    elements['audio-capture-range'].textContent = '当前未接入会议声音。';
    elements['system-audio-status'].textContent = '实验入口尚未启动。';
  }
  if (!options.omitOverview) elements["monitor-audio-feedback"] = Object.assign(new Element(), { hidden: true });
  const display = new Stream([new Track("video", "display-video", { displaySurface: options.displaySurface || "monitor" }), ...(options.noSystemAudio ? [] : [new Track("audio", "system-audio")])]);
  const microphone = new Stream([new Track("audio", "microphone")]);
  const window = new Events();
  // Existing lifecycle assertions exercise Chinese; the explicit default-language test omits this helper.
  if (!options.withoutI18n) window.MeetingI18n = {
    language: options.language || 'zh',
    get speechLanguage() { return this.language === 'zh' ? 'zh-CN' : 'en-US'; }
  };
  const calls = { display: [], microphone: [], displayStreams: [], microphoneStreams: [], recognizers: [], audioContexts: [], posts: [], acceptedPosts: [], mode: [], states: [], timers: [] };
  const control = { meetingId: "meeting-before-reset", session: { status: "running", generation: 1 } };
  window.addEventListener("meeting-audio-mode", (event) => calls.mode.push(event.detail));
  class Recognition {
    constructor() { this.startArguments = []; this.abortCount = 0; calls.recognizers.push(this); }
    start(...args) {
      this.startArguments.push(args);
      if (options.recognitionStartError) throw options.recognitionStartError;
      if (!options.deferRecognitionStart) this.onstart?.();
    }
    abort() { this.abortCount++; }
  }
  class AudioContext {
    constructor(options = {}) { this.options = options; this.closeCount = 0; this.sources = []; this.mixedTrack = new Track("audio", "mixed-destination"); calls.audioContexts.push(this); }
    createMediaStreamDestination() { this.destination = { stream: new Stream([this.mixedTrack]) }; return this.destination; }
    createMediaStreamSource(stream) { this.sources.push(stream); return { connect() {} }; }
    async resume() {}
    async close() { this.closeCount++; }
  }
  window.SpeechRecognition = Recognition;
  window.AudioContext = AudioContext;
  const navigator = {
    userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Edg/140.0.0.0",
    mediaDevices: {
      getDisplayMedia: async (constraints) => {
        calls.display.push(constraints);
        const stream = calls.display.length === 1 ? display : new Stream([new Track("video", "display-video"), new Track("audio", "system-audio")]);
        calls.displayStreams.push(stream);
        return options.displayGate && calls.display.length === 1 ? options.displayGate.promise : stream;
      },
      getUserMedia: async (constraints) => {
        calls.microphone.push(constraints);
        const stream = calls.microphone.length === 1 ? microphone : new Stream([new Track("audio", "microphone")]);
        calls.microphoneStreams.push(stream);
        return options.microphoneGate && calls.microphone.length === 1 ? options.microphoneGate.promise : stream;
      }
    }
  };
  if (options.noMicrophoneApi) delete navigator.mediaDevices.getUserMedia;
  const fetch = async (path, request = {}) => {
    if (path === "/api/state") {
      const snapshot = { meetingId: control.meetingId, session: { ...control.session } };
      calls.states.push(snapshot);
      return { ok: true, json: async () => snapshot };
    }
    assert.equal(path, "/api/utterances");
    const body = JSON.parse(request.body);
    calls.posts.push(body);
    if (options.postGate) await options.postGate.promise;
    const current = body.meetingId === control.meetingId && control.session.status === "running" && body.sessionGeneration === control.session.generation;
    if (current) calls.acceptedPosts.push(body);
    return { ok: current, json: async () => current ? {} : { error: "旧会话请求已拒绝" } };
  };
  const context = vm.createContext({
    window, navigator, document: { getElementById: (id) => elements[id] },
    fetch, MediaStream: Stream,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    console,
    setTimeout: (callback, delay) => { const timer = { callback, delay, cancelled: false, ran: false }; calls.timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; }
  });
  vm.runInContext(source, context, { filename: "system-audio.js" });
  const publishSession = (status = control.session.status, generation = control.session.generation) => {
    control.session = { status, generation };
    window.dispatchEvent({ type: "meeting-session-state", detail: { running: status === "running", generation, meetingId: control.meetingId } });
  };
  if (options.publishSession !== false) publishSession();
  const start = () => elements["system-audio-start"].click();
  const stop = () => window.dispatchEvent({ type: "meeting-stop-system-audio" });
  const finalResult = (text) => { const result = [{ transcript: text }]; result.isFinal = true; return { resultIndex: 0, results: [result] }; };
  const runTimers = () => {
    for (const timer of [...calls.timers]) { if (!timer.cancelled && !timer.ran) { timer.ran = true; timer.callback(); } }
  };
  const changeLanguage = language => {
    window.MeetingI18n.language = language;
    window.dispatchEvent({ type: 'meeting-language-changed', detail: { language } });
  };
  return { elements, calls, control, display, microphone, start, stop, finalResult, publishSession, runTimers, changeLanguage };
}
function allStopped(stream) { assert(stream.getTracks().every((track) => track.readyState === "ended")); }
function assertStatus(h, state, textPattern) {
  const status = h.elements["system-audio-status"];
  assert.equal(status.dataset.state, state);
  if (textPattern) assert.match(status.textContent, textPattern);
  const overview = h.elements["monitor-audio-feedback"];
  if (overview) {
    assert.equal(overview.dataset.state, state);
    assert.equal(overview.hidden, state === "idle");
    if (state !== "idle") assert.equal(overview.textContent, status.textContent);
  }
}

test("initial audio scope and inactive status survive repeated English-Chinese toggles", () => {
  const h = harness({ seedMarkup: true, language: 'en', publishSession: false });
  for (let i = 0; i < 3; i++) {
    assert.equal(h.elements['audio-capture-range'].textContent, 'Meeting audio is not connected.');
    assert.equal(h.elements['system-audio-status'].textContent, 'Experimental capture has not started.');
    h.changeLanguage('zh');
    assert.equal(h.elements['audio-capture-range'].textContent, '当前未接入会议声音。');
    assert.equal(h.elements['system-audio-status'].textContent, '实验入口尚未启动。');
    h.changeLanguage('en');
  }
  h.stop(); h.changeLanguage('zh'); h.changeLanguage('en');
  assert.equal(h.elements['audio-capture-range'].textContent, 'Meeting audio is not connected.');
  assert.equal(h.elements['system-audio-status'].textContent, 'Meeting transcription stopped.');
});

test("English is the audio default and recognized speech is retained exactly", async () => {
  const h = harness({ withoutI18n: true });
  assert.equal(h.elements['system-audio-start'].textContent, 'Start meeting transcription');
  assert.equal(/\p{Script=Han}/u.test(h.elements['system-audio-steps'].innerHTML), false);
  h.start(); await flush();
  assertStatus(h, 'active', /Speech recognition started/);
  const recognition = h.calls.recognizers[0];
  assert.equal(recognition.lang, 'en-US');
  recognition.onresult(h.finalResult('Alex, please confirm ten forty. 原话保留。')); await flush();
  assert.equal(h.calls.acceptedPosts[0].text, 'Alex, please confirm ten forty. 原话保留。');
  assert.equal(h.calls.acceptedPosts[0].speaker, 'Mixed meeting audio (speaker not identified)');
  h.stop();
});

test("changing language keeps capture and saved text while updating ASR language on resume", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0], track = recognition.startArguments[0][0];
  recognition.onresult(h.finalResult('已保留的原始发言。')); await flush();
  h.changeLanguage('en');
  assert.equal(recognition.abortCount, 0);
  assert.equal(recognition.lang, 'en-US');
  assert.equal(track.readyState, 'live');
  assert.equal(h.calls.acceptedPosts[0].text, '已保留的原始发言。');
  assert.equal(h.elements['system-audio-start'].textContent, 'Start meeting transcription');
  recognition.onend(); h.runTimers();
  assert.equal(recognition.startArguments[1][0], track);
  assert.equal(h.calls.display.length, 1);
  assert.equal(h.calls.microphone.length, 1);
  h.stop();
});

test("missing system audio releases display tracks without trying microphone or ASR", async () => {
  const h = harness({ noSystemAudio: true, displaySurface: "window" });
  h.start(); await flush();
  assert.equal(h.calls.display.length, 1);
  assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.recognizers.length, 0);
  allStopped(h.display);
  assertStatus(h, "error", /没有取得系统音频/);
  assert.equal(h.elements["system-audio-start"].disabled, false);
  assert.equal(h.elements["system-audio-stop"].disabled, true);
  assert.equal(h.elements["system-audio-start"].textContent, "重试会议声音转写");
  h.publishSession("running", 1);
  assertStatus(h, "error", /没有取得系统音频/); // Ordinary polling must not erase the diagnostic.
  h.start(); await flush();
  assert.equal(h.calls.display.length, 2);
  assert.equal(h.calls.microphone.length, 1);
  assert.equal(h.calls.recognizers.length, 1);
  assertStatus(h, "active");
  h.calls.recognizers[0].onresult(h.finalResult("重试成功后的最终转写")); await flush();
  assert.equal(h.calls.acceptedPosts.length, 1);
  assertStatus(h, "active");
  h.stop();
  assertStatus(h, "idle");
  assert.equal(h.elements["system-audio-start"].textContent, "开始会议声音转写");
});

test("stop during display permission wait releases the late display stream", async () => {
  const gate = deferred(), h = harness({ displayGate: gate });
  h.start(); await flush();
  assertStatus(h, "pending", /第\s*1\/3\s*步/);
  h.stop();
  assertStatus(h, "idle");
  const stoppedText = h.elements["system-audio-status"].textContent;
  gate.resolve(h.display); await flush();
  allStopped(h.display);
  assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.recognizers.length, 0);
  assert.equal(h.elements["system-audio-stop"].disabled, true);
  assertStatus(h, "idle");
  assert.equal(h.elements["system-audio-status"].textContent, stoppedText);
});

test("stop during microphone permission wait releases both current and late streams", async () => {
  const gate = deferred(), h = harness({ microphoneGate: gate });
  h.start(); await flush();
  assert.equal(h.calls.microphone.length, 1);
  assertStatus(h, "pending", /第\s*2\/3\s*步/);
  h.stop(); allStopped(h.display);
  gate.resolve(h.microphone); await flush();
  allStopped(h.microphone);
  assert.equal(h.calls.recognizers.length, 0);
  assert.equal(h.calls.audioContexts.length, 0);
  assertStatus(h, "idle");
});

test("speech service failure aborts recognition and closes all capture resources", async () => {
  const h = harness();
  h.start(); await flush();
  const recognition = h.calls.recognizers[0], audioContext = h.calls.audioContexts[0];
  assert(recognition);
  assert.equal(audioContext.options.sampleRate, 16000, "resample before ASR: real Edge tests rejected the default 48 kHz input");
  assert.equal(audioContext.destination.channelCount, 1);
  assert.equal(audioContext.sources.length, 2, "both system audio and microphone must feed the normalized mix");
  assert.equal(recognition.startArguments.length, 1);
  assert.equal(recognition.startArguments[0][0], audioContext.mixedTrack);
  recognition.onerror({ error: "audio-capture" }); await flush();
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(recognition.abortCount, 1);
  assert.equal(audioContext.closeCount, 1);
  assert.equal(audioContext.mixedTrack.readyState, "ended");
  assert.equal(recognition.onresult, null);
  assert.match(h.elements["system-audio-status"].textContent, /无法使用混合音轨/);
  assert.equal(h.calls.mode.at(-1).active, false);
  assertStatus(h, "error", /无法使用混合音轨/);
  assert.equal(h.elements["system-audio-start"].textContent, "重试会议声音转写");
});

test("unsupported audio-track start does not retry a microphone-only start", async () => {
  const h = harness({ recognitionStartError: new TypeError("audioTrack not supported") });
  h.start(); await flush();
  assert.equal(h.calls.recognizers.length, 1);
  const recognition = h.calls.recognizers[0];
  assert.equal(recognition.startArguments.length, 1);
  assert.equal(recognition.startArguments[0].length, 1);
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(h.calls.audioContexts[0].closeCount, 1);
  assert.match(h.elements["system-audio-status"].textContent, /未启动/);
  assertStatus(h, "error", /audioTrack not supported/);
});

test("reset discards queued final results and ignores a stale recognition callback", async () => {
  const h = harness();
  h.start(); await flush();
  const staleHandler = h.calls.recognizers[0].onresult;
  staleHandler(h.finalResult("尚未发送的旧会话结果一"));
  staleHandler(h.finalResult("尚未发送的旧会话结果二"));
  h.stop(); h.control.meetingId = "meeting-after-reset";
  await flush();
  staleHandler(h.finalResult("停止后迟到的旧会话结果")); await flush();
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.acceptedPosts.length, 0);
  allStopped(h.display); allStopped(h.microphone);
});

test("an in-flight old result carries its old meeting ID; queued successors are discarded", async () => {
  const gate = deferred(), h = harness({ postGate: gate });
  h.start(); await flush();
  const handler = h.calls.recognizers[0].onresult;
  handler(h.finalResult("已在途的旧会话结果")); await flush();
  assert.equal(h.calls.posts.length, 1);
  handler(h.finalResult("后续排队结果"));
  h.stop(); h.control.meetingId = "meeting-after-reset";
  gate.resolve(); await flush();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].meetingId, "meeting-before-reset");
  assert.equal(h.calls.posts[0].source, "browser_mixed");
  assert.equal(h.calls.acceptedPosts.length, 0);
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(h.elements["system-audio-start"].disabled, false);
});

test("capture stays disabled until a running session and never auto-starts on resume", async () => {
  const h = harness({ publishSession: false });
  assert.equal(h.elements["system-audio-start"].disabled, true);
  h.start(); await flush(); // Also protect a synthetic click bypassing button.disabled.
  assert.equal(h.calls.display.length, 0);
  assert.equal(h.calls.states.length, 0);
  h.publishSession("idle", 0); h.start(); await flush();
  assert.equal(h.calls.display.length, 0);
  h.publishSession("running", 1);
  assert.equal(h.elements["system-audio-start"].disabled, false);
  assert.equal(h.calls.display.length, 0);
  h.publishSession("stopped", 2); h.stop();
  assert.equal(h.elements["system-audio-start"].disabled, true);
  h.start(); await flush();
  assert.equal(h.calls.display.length, 0);
  h.publishSession("running", 3);
  assert.equal(h.elements["system-audio-start"].disabled, false);
  assert.equal(h.calls.display.length, 0);
  h.publishSession("stopped", 3); h.publishSession("running", 3); // Failed stop transition returns to the same generation.
  assert.match(h.elements["system-audio-status"].textContent, /会议已开始/);
  assert.equal(h.calls.display.length, 0);
});

test("same running broadcast preserves capture; stop and resume reject old callbacks and attach the new generation", async () => {
  const h = harness();
  h.start(); await flush();
  const oldRecognition = h.calls.recognizers[0], oldHandler = oldRecognition.onresult;
  const oldTrackEnded = h.display.getTracks()[0].onended;
  h.publishSession("running", 1);
  assert.equal(oldRecognition.abortCount, 0);
  oldHandler(h.finalResult("本段正常转写")); await flush();
  assert.equal(h.calls.acceptedPosts[0].sessionGeneration, 1);
  h.publishSession("stopped", 2);
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(oldRecognition.abortCount, 1);
  assert.equal(h.elements["system-audio-start"].disabled, true);
  h.publishSession("running", 3);
  oldHandler(h.finalResult("继续后迟到的旧转写")); await flush();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.recognizers.length, 1);
  h.start(); await flush();
  oldTrackEnded();
  assert.equal(h.calls.recognizers[1].abortCount, 0);
  h.calls.recognizers[1].onresult(h.finalResult("继续会议的新转写")); await flush();
  assert.equal(h.calls.acceptedPosts.length, 2);
  assert.equal(h.calls.acceptedPosts[1].meetingId, "meeting-before-reset");
  assert.equal(h.calls.acceptedPosts[1].sessionGeneration, 3);
});

test("late screen permission after stop and resume releases only the old stream", async () => {
  const gate = deferred(), h = harness({ displayGate: gate });
  h.start(); await flush();
  h.publishSession("stopped", 2); h.publishSession("running", 3);
  h.start(); await flush();
  const currentRecognition = h.calls.recognizers[0];
  assert(currentRecognition);
  gate.resolve(h.display); await flush();
  allStopped(h.display);
  assert(h.calls.displayStreams[1].getTracks().every(t => t.readyState === "live"));
  assert.equal(currentRecognition.abortCount, 0);
  currentRecognition.onresult(h.finalResult("新段会话的有效结果")); await flush();
  assert.equal(h.calls.acceptedPosts[0].sessionGeneration, 3);
});

test("late microphone permission cannot revive capture across stop and resume", async () => {
  const gate = deferred(), h = harness({ microphoneGate: gate });
  h.start(); await flush();
  assert.equal(h.calls.microphone.length, 1);
  h.publishSession("stopped", 2); h.publishSession("running", 3);
  gate.resolve(h.microphone); await flush();
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(h.calls.recognizers.length, 0);
  assert.equal(h.elements["system-audio-start"].disabled, false);
});

test("permissions are followed by a fresh server-session check even without a broadcast", async () => {
  const gate = deferred(), h = harness({ microphoneGate: gate });
  h.start(); await flush();
  // The backend stopped and continued the same meeting before the next UI poll.
  h.control.session = { status: "running", generation: 3 };
  gate.resolve(h.microphone); await flush();
  assert.equal(h.calls.states.length, 2);
  assert.equal(h.calls.states[0].session.generation, 1);
  assert.equal(h.calls.states[1].session.generation, 3);
  allStopped(h.display); allStopped(h.microphone);
  assert.equal(h.calls.recognizers.length, 0);
  assert.match(h.elements["system-audio-status"].textContent, /会议已停止或已切换/);
});

test("a stale running UI cannot start ASR when the starting server state is stopped", async () => {
  const h = harness();
  h.control.session = { status: "stopped", generation: 2 };
  h.start(); await flush();
  allStopped(h.display);
  assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.recognizers.length, 0);
});

test("an in-flight old-generation result is rejected after stop and resume of the same meeting", async () => {
  const gate = deferred(), h = harness({ postGate: gate });
  h.start(); await flush();
  const oldHandler = h.calls.recognizers[0].onresult;
  oldHandler(h.finalResult("已在途的旧代结果")); await flush();
  oldHandler(h.finalResult("旧代排队的后续结果"));
  h.publishSession("stopped", 2); h.publishSession("running", 3);
  gate.resolve(); await flush();
  oldHandler(h.finalResult("旧代迟到回调")); await flush();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].sessionGeneration, 1);
  assert.equal(h.calls.posts[0].meetingId, h.control.meetingId);
  assert.equal(h.calls.acceptedPosts.length, 0);
  allStopped(h.display); allStopped(h.microphone);
});

test("capture reports screen, microphone and ASR stages before becoming active", async () => {
  const displayGate = deferred(), microphoneGate = deferred();
  const h = harness({ displayGate, microphoneGate, deferRecognitionStart: true });
  h.start(); await flush();
  assertStatus(h, "pending", /第\s*1\/3\s*步/);
  assert.equal(h.elements["system-audio-start"].textContent, "正在开启…");
  assert.equal(h.elements["system-audio-start"].disabled, true);
  assert.equal(h.elements["system-audio-stop"].disabled, false);
  assert.equal(h.calls.microphone.length, 0);
  displayGate.resolve(h.display); await flush();
  assertStatus(h, "pending", /第\s*2\/3\s*步/);
  assert.equal(h.calls.recognizers.length, 0);
  microphoneGate.resolve(h.microphone); await flush();
  assertStatus(h, "pending", /第\s*3\/3\s*步/);
  assert.equal(h.calls.mode.some(event => event.active), false);
  assert.equal(h.calls.posts.length, 0);
  const recognition = h.calls.recognizers[0];
  recognition.onstart();
  assertStatus(h, "active");
  assert.equal(h.calls.mode.at(-1).active, true);
  const interim = h.finalResult("尚未确认的临时识别文字"); interim.results[0].isFinal = false;
  recognition.onresult(interim); await flush();
  assertStatus(h, "active");
  assert.equal(h.calls.posts.length, 0);
  h.publishSession("stopped", 2);
  assertStatus(h, "idle");
  assert.equal(h.elements["system-audio-start"].disabled, true);
  allStopped(h.display); allStopped(h.microphone);
});

for (const stage of ["display", "microphone"]) {
  test(`${stage} permission rejection surfaces an error and releases obtained tracks`, async () => {
    const gate = deferred(), h = harness({ [stage === "display" ? "displayGate" : "microphoneGate"]: gate });
    h.start(); await flush();
    gate.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await flush();
    assertStatus(h, "error", /未授权/);
    assert.equal(h.elements["system-audio-start"].disabled, false);
    assert.equal(h.elements["system-audio-stop"].disabled, true);
    assert.equal(h.elements["system-audio-start"].textContent, "重试会议声音转写");
    assert.equal(h.calls.recognizers.length, 0);
    assert.equal(h.calls.posts.length, 0);
    if (stage === "display") assert.equal(h.calls.microphone.length, 0);
    else allStopped(h.display);
  });
}

test("the optional overview element is not required for failure or retry", async () => {
  const h = harness({ omitOverview: true, noSystemAudio: true });
  h.start(); await flush();
  assertStatus(h, "error", /没有取得系统音频/);
  h.start(); await flush();
  assertStatus(h, "active");
  h.stop();
  assertStatus(h, "idle");
  allStopped(h.calls.displayStreams[1]); allStopped(h.microphone);
});

test("normal recognition end resumes on the same normalized track without asking capture permissions again", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0], track = recognition.startArguments[0][0];
  recognition.onend();
  assertStatus(h, "pending", /自动继续/);
  assert.equal(h.elements["system-audio-stop"].disabled, false);
  h.runTimers();
  assertStatus(h, "active");
  assert.equal(recognition.startArguments.length, 2);
  assert.equal(recognition.startArguments[1][0], track);
  assert.equal(h.calls.display.length, 1); assert.equal(h.calls.microphone.length, 1);
  recognition.onresult(h.finalResult("恢复后的新发言")); await flush();
  assert.equal(h.calls.acceptedPosts[0].text, "恢复后的新发言");
  h.stop();
});

test("stopping or changing sessions cancels a scheduled recognition resume", async () => {
  for (const action of [h => h.stop(), h => h.publishSession("stopped", 2), h => h.publishSession("running", 2)]) {
    const h = harness(); h.start(); await flush();
    const recognition = h.calls.recognizers[0]; recognition.onend(); action(h); h.runTimers();
    assert.equal(recognition.startArguments.length, 1);
    allStopped(h.display); allStopped(h.microphone);
  }
});

test("repeated normal ends cannot create an endless rapid restart loop", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0];
  for (let i = 0; i < 3; i++) { recognition.onend(); h.runTimers(); }
  assert.equal(recognition.startArguments.length, 4);
  recognition.onend(); h.runTimers();
  assertStatus(h, "error", /反复结束/);
  assert.equal(recognition.startArguments.length, 4);
  allStopped(h.display); allStopped(h.microphone);
});

test("a non-network speech service error cancels pending normal-end resumes", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0]; recognition.onend(); recognition.onerror({ error: "audio-capture" }); h.runTimers();
  assert.equal(recognition.startArguments.length, 1);
  assertStatus(h, "error", /无法使用混合音轨/);
  allStopped(h.display); allStopped(h.microphone);
});

test("transient network failures resume on the existing track and preserve accepted words", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0];
  recognition.onresult(h.finalResult("中断之前的发言")); await flush();
  recognition.onerror({ error: "network" }); recognition.onend();
  assertStatus(h, "pending", /自动重连（1\/2）/);
  assert.equal(h.calls.timers.filter(t => !t.cancelled && !t.ran).length, 1);
  h.runTimers();
  assert.equal(recognition.startArguments.length, 2);
  recognition.onresult(h.finalResult("恢复后的发言")); await flush();
  assert.deepEqual(h.calls.acceptedPosts.map(p => p.text), ["中断之前的发言", "恢复后的发言"]);
  recognition.onerror({ error: "network" });
  assertStatus(h, "pending", /自动重连（1\/2）/);
  h.stop(); h.runTimers();
  assert.equal(recognition.startArguments.length, 2);
  assert.equal(h.calls.display.length, 1); assert.equal(h.calls.microphone.length, 1);
});

test("network reconnection stops after two retries without useful final text", async () => {
  const h = harness(); h.start(); await flush();
  const recognition = h.calls.recognizers[0];
  for (let i = 0; i < 2; i++) { recognition.onerror({ error: "network" }); recognition.onend(); h.runTimers(); }
  assert.equal(recognition.startArguments.length, 3);
  recognition.onerror({ error: "network" }); h.runTimers();
  assertStatus(h, "error", /自动重连仍未恢复/);
  assert.equal(recognition.startArguments.length, 3);
  allStopped(h.display); allStopped(h.microphone);
});

test("window audio requests a limited picker and waits for explicit audio-scope confirmation before microphone or ASR", async () => {
  const h = harness({ source: "window", displaySurface: "window" });
  h.start(); await flush();
  const request = h.calls.display[0];
  assert.equal(request.windowAudio, "window"); assert.equal(request.systemAudio, "exclude");
  assert.equal(request.video.displaySurface, "window"); assert.equal(request.monitorTypeSurfaces, "exclude");
  assert.equal(h.elements["window-audio-confirmation"].hidden, false);
  assertStatus(h, "pending", /选择了窗口画面，并不能证明声音已隔离/);
  assert.equal(h.calls.microphone.length, 0); assert.equal(h.calls.recognizers.length, 0);
  assert.equal(h.elements["meeting-audio-source"].disabled, true);
  h.elements["confirm-window-audio"].click(); await flush();
  assertStatus(h, "active");
  assert.equal(h.calls.microphone.length, 1);
  assert.equal(h.elements["window-audio-confirmation"].hidden, true);
  assert.match(h.elements["audio-capture-range"].textContent, /隔离仍需实测/);
  h.calls.recognizers[0].onresult(h.finalResult("来自所选应用的发言")); await flush();
  assert.match(h.calls.acceptedPosts[0].speaker, /所选应用音频/);
  assert.match(h.calls.mode.at(-1).sourceLabel, /指定应用音频/);
  h.stop(); assert.equal(h.elements["meeting-audio-source"].disabled, false);
});

test("a selected screen or unknown display surface cannot masquerade as application-only audio", async () => {
  for (const displaySurface of ["monitor", "browser", ""]) {
    const h = harness({ source: "window", displaySurface: displaySurface || "unknown" });
    h.start(); await flush();
    assertStatus(h, "error", /没有选中应用窗口/);
    assert.equal(h.calls.microphone.length, 0); assert.equal(h.calls.recognizers.length, 0);
    assert.equal(h.calls.display.length, 1); allStopped(h.display);
  }
});

test("unsupported window audio never falls back to whole-computer capture", async () => {
  const h = harness({ source: "window", displaySurface: "window", noSystemAudio: true });
  h.start(); await flush();
  assertStatus(h, "error", /没有为所选窗口提供音频/);
  assert.equal(h.calls.display.length, 1); assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.recognizers.length, 0); allStopped(h.display);
});

test("an unsupported windowAudio option fails clearly without retrying a broader capture", async () => {
  const gate = deferred(), h = harness({ source: "window", displaySurface: "window", displayGate: gate });
  h.start(); gate.reject(Object.assign(new Error("Unsupported windowAudio enum"), { name: "TypeError" })); await flush();
  assertStatus(h, "error", /不支持此次指定应用音频请求/);
  assert.equal(h.calls.display.length, 1); assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.recognizers.length, 0);
});

test("cancel or stop while confirming the application scope closes and releases capture without starting recognition", async () => {
  for (const action of [h => h.elements["cancel-window-audio"].click(), h => h.stop(), h => h.publishSession("stopped", 2)]) {
    const h = harness({ source: "window", displaySurface: "window" });
    h.start(); await flush(); action(h); await flush();
    h.elements["confirm-window-audio"].click(); await flush();
    assert.equal(h.elements["window-audio-confirmation"].hidden, true);
    assert.equal(h.calls.recognizers.length, 0); assert.equal(h.calls.microphone.length, 0); allStopped(h.display);
  }
});

test("confirmation rechecks the server session before opening the microphone", async () => {
  const h = harness({ source: "window", displaySurface: "window" });
  h.start(); await flush(); h.control.session = { status: "stopped", generation: 2 };
  h.elements["confirm-window-audio"].click(); await flush();
  assertStatus(h, "error", /会议已停止或已切换/);
  assert.equal(h.calls.microphone.length, 0); assert.equal(h.calls.recognizers.length, 0); allStopped(h.display);
});

test("microphone opt-out works without a microphone API and only mixes the selected audio", async () => {
  const h = harness({ includeMic: false, noMicrophoneApi: true });
  h.start(); await flush();
  assertStatus(h, "active"); assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.audioContexts[0].sources.length, 1);
  assert.match(h.calls.mode.at(-1).sourceLabel, /未收麦克风/);
  assert.match(h.elements["audio-capture-range"].textContent, /全电脑系统声音；未收麦克风/);
  h.stop();
});

test("application audio can exclude the microphone without silently broadening its source", async () => {
  const h = harness({ source: "window", displaySurface: "window", includeMic: false });
  h.start(); await flush(); h.elements["confirm-window-audio"].click(); await flush();
  assertStatus(h, "active"); assert.equal(h.calls.microphone.length, 0);
  assert.equal(h.calls.audioContexts[0].sources.length, 1);
  assert.match(h.calls.mode.at(-1).sourceLabel, /指定应用音频（未收麦克风）/);
  assert.equal(h.calls.display.length, 1); h.stop();
});
