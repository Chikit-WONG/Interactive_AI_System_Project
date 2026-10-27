// Browser capture doubles only: these tests never request a real screen or microphone.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalRecorder, chooseWebmType, recordingSupport, formatDuration } from "../public/recorder.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, values = {}) { for (const fn of this.listeners.get(type) || []) fn({ type, ...values }); }
}
class Track extends Events {
  constructor(kind) { super(); this.kind = kind; this.readyState = "live"; this.stopCount = 0; }
  stop() { this.stopCount++; this.readyState = "ended"; }
  endExternally() { this.readyState = "ended"; this.emit("ended"); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((x) => x.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((x) => x.kind === "audio"); }
}
function harness(options = {}) {
  const display = new Stream([new Track("video"), ...(options.noSystemAudio ? [] : [new Track("audio")])]);
  const mic = new Stream([new Track("audio")]);
  const calls = { display: [], mic: [], recorders: [], contexts: [], timers: new Map(), updates: [] };
  let clock = 0;
  class Recorder extends Events {
    static isTypeSupported(type) { return options.unsupported ? false : type.startsWith("video/webm"); }
    constructor(stream, config) {
      super();
      if (options.constructorError) throw options.constructorError;
      this.stream = stream; this.mimeType = config.mimeType; this.state = "inactive"; this.stopCalls = 0;
      calls.recorders.push(this);
    }
    start(timeslice) {
      if (options.startError) throw options.startError;
      this.timeslice = timeslice; this.state = "recording";
    }
    stop() { this.stopCalls++; this.state = "inactive"; }
    chunk(text) { this.emit("dataavailable", { data: new Blob([text]) }); }
    finish(text = "final") { this.state = "inactive"; this.chunk(text); this.emit("stop"); }
    fail() { this.state = "inactive"; this.emit("error", { error: new Error("encoder failed") }); }
  }
  class Context {
    constructor() { this.state = "suspended"; this.closeCount = 0; this.nodes = []; calls.contexts.push(this); }
    node(stream) {
      const node = { stream, disconnectCount: 0, connect() {}, disconnect() { this.disconnectCount++; } };
      this.nodes.push(node); return node;
    }
    createMediaStreamDestination() { return this.node(new Stream([new Track("audio")])); }
    createMediaStreamSource(stream) { return this.node(stream); }
    async resume() { if (options.resumeError) throw options.resumeError; this.state = "running"; }
    async close() { this.closeCount++; this.state = "closed"; }
  }
  const env = {
    isSecureContext: true, Blob, MediaStream: Stream, MediaRecorder: Recorder, AudioContext: Context,
    navigator: { mediaDevices: {
      getDisplayMedia: async (config) => {
        calls.display.push(config);
        if (options.displayError) throw options.displayError;
        return options.displayGate ? options.displayGate.promise : display;
      },
      getUserMedia: async (config) => {
        calls.mic.push(config);
        if (options.micError) throw options.micError;
        return options.micGate ? options.micGate.promise : mic;
      }
    } },
    performance: { now: () => clock },
    setInterval(fn) { const id = calls.timers.size + 1; calls.timers.set(id, fn); return id; },
    clearInterval(id) { calls.timers.delete(id); },
  };
  const controller = new LocalRecorder(env, (view) => calls.updates.push(view));
  return { controller, calls, display, mic, env, advance(ms) { clock += ms; for (const fn of calls.timers.values()) fn(); } };
}
function stopped(stream) { assert(stream.getTracks().every((t) => t.readyState === "ended")); }

test("WebM capability is checked before capture; video-only codec and duration are selectable", async () => {
  const h = harness({ unsupported: true });
  assert.equal(recordingSupport(h.env).ok, false);
  await h.controller.start();
  assert.equal(h.calls.display.length, 0);
  assert.equal(h.controller.state, "idle");
  assert.equal(chooseWebmType(harness().env.MediaRecorder, false), "video/webm;codecs=vp8");
  assert.equal(formatDuration(301000), "05:01");
});

test("mixed recording releases every track/context and waits for final data + stop before saving", async () => {
  const h = harness();
  await h.controller.start({ systemAudio: true, microphone: true });
  const r = h.calls.recorders[0], context = h.calls.contexts[0];
  assert.equal(h.controller.state, "recording");
  assert.equal(r.stream.getVideoTracks().length, 1);
  assert.equal(r.stream.getAudioTracks().length, 1);
  assert.equal(r.timeslice, 1000);
  r.chunk("first-");
  h.advance(5000);
  h.controller.stop();
  assert.equal(h.controller.state, "finalizing");
  assert.equal(h.controller.blob, null);
  assert.equal(h.controller.markDownloadRequested(), false);
  assert.equal(h.controller.hasUnsavedWork(), true);
  stopped(h.display); stopped(h.mic); stopped(context.nodes[0].stream);
  assert.equal(context.closeCount, 1);
  assert(context.nodes.every((node) => node.disconnectCount === 1));
  assert.equal(h.calls.timers.size, 0);
  r.chunk("last-");
  assert.equal(h.controller.blob, null);
  r.finish("tail");
  await flush();
  assert.equal(h.controller.state, "ready");
  assert.equal(await h.controller.blob.text(), "first-last-tail");
  assert.equal(h.controller.elapsedMs, 5000);
  assert.equal(h.controller.hasUnsavedWork(), true);
  assert.equal(h.controller.markDownloadRequested(), true);
  assert.equal(h.controller.hasUnsavedWork(), false);
  h.controller.stop(); h.controller.dispose();
  assert.equal(context.closeCount, 1);
  assert.equal(r.stopCalls, 1);
  assert(h.display.getTracks().every((t) => t.stopCount === 1));
});

test("screen-only recording never requests a microphone or creates an audio mixer", async () => {
  const h = harness({ noSystemAudio: true });
  await h.controller.start({ systemAudio: false, microphone: false });
  assert.equal(h.calls.display[0].audio, false);
  assert.equal(h.calls.mic.length, 0);
  assert.equal(h.calls.contexts.length, 0);
  assert.equal(h.calls.recorders[0].stream.getAudioTracks().length, 0);
  assert.match(h.controller.audio, /无声录像/);
  h.controller.stop(); h.calls.recorders[0].finish(); await flush();
  assert(h.controller.blob.size > 0);
  stopped(h.display);
});

test("requested but missing system audio is shown truthfully and optional mic can still record", async () => {
  const h = harness({ noSystemAudio: true });
  await h.controller.start({ systemAudio: true, microphone: true });
  assert.match(h.controller.audio, /未取得共享音轨/);
  assert.match(h.controller.audio, /已取得麦克风音轨/);
  assert.equal(h.calls.contexts.length, 0);
  h.controller.stop(); h.calls.recorders[0].finish(); await flush();
  stopped(h.display); stopped(h.mic);
});

test("cancel while screen permission is pending releases a late screen result", async () => {
  const gate = deferred(), h = harness({ displayGate: gate });
  const pending = h.controller.start({ microphone: true });
  h.controller.stop();
  gate.resolve(h.display); await pending;
  stopped(h.display);
  assert.equal(h.calls.mic.length, 0);
  assert.equal(h.calls.recorders.length, 0);
  assert.equal(h.controller.state, "idle");
});

test("cancel while microphone permission is pending releases current and late tracks", async () => {
  const gate = deferred(), h = harness({ micGate: gate });
  const pending = h.controller.start({ microphone: true });
  await flush();
  h.controller.stop();
  stopped(h.display);
  gate.resolve(h.mic); await pending;
  stopped(h.mic);
  assert.equal(h.calls.recorders.length, 0);
  assert.equal(h.calls.contexts.length, 0);
});

test("denied microphone permission releases an already acquired screen", async () => {
  const h = harness({ micError: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
  await h.controller.start({ microphone: true });
  stopped(h.display);
  assert.equal(h.controller.state, "idle");
  assert.equal(h.controller.blob, null);
  assert.match(h.controller.message, /未获得/);
  assert.equal(h.calls.recorders.length, 0);
});

test("denied screen permission starts neither microphone nor recorder", async () => {
  const h = harness({ displayError: Object.assign(new Error("cancelled"), { name: "NotAllowedError" }) });
  await h.controller.start({ microphone: true });
  assert.equal(h.calls.mic.length, 0);
  assert.equal(h.calls.recorders.length, 0);
  assert.equal(h.controller.hasUnsavedWork(), false);
});

for (const failure of ["constructorError", "startError", "resumeError"]) {
  test(failure + " cleans acquired screen/mic and mixer resources", async () => {
    const h = harness({ [failure]: new Error("not available") });
    await h.controller.start({ microphone: true });
    stopped(h.display); stopped(h.mic);
    assert.equal(h.calls.contexts[0].closeCount, 1);
    stopped(h.calls.contexts[0].nodes[0].stream);
    assert.equal(h.controller.state, "idle");
    assert.equal(h.controller.blob, null);
  });
}

test("ending screen sharing follows the same final-chunk workflow and ignores duplicate stop", async () => {
  const h = harness();
  await h.controller.start();
  h.display.getVideoTracks()[0].endExternally();
  h.controller.stop();
  assert.equal(h.calls.recorders[0].stopCalls, 1);
  assert.equal(h.controller.blob, null);
  h.calls.recorders[0].finish(); await flush();
  assert.equal(h.controller.state, "ready");
  stopped(h.display);
});

test("encoder error still retains the subsequent final chunk and releases capture resources", async () => {
  const h = harness();
  await h.controller.start({ microphone: true });
  const r = h.calls.recorders[0];
  r.chunk("before-error-"); r.fail();
  assert.equal(h.controller.blob, null);
  assert.equal(h.controller.state, "finalizing");
  stopped(h.display); stopped(h.mic);
  r.finish("last");
  await flush();
  assert.equal(await h.controller.blob.text(), "before-error-last");
  assert.match(h.controller.message, /中断/);
  assert.equal(h.calls.contexts[0].closeCount, 1);
});

test("a stale ended/error callback cannot stop a later recording", async () => {
  const h = harness();
  await h.controller.start();
  const oldTrack = h.display.getVideoTracks()[0], oldRecorder = h.calls.recorders[0];
  h.controller.stop(); oldRecorder.finish(); await flush();
  const nextDisplay = new Stream([new Track("video")]);
  h.env.navigator.mediaDevices.getDisplayMedia = async () => nextDisplay;
  await h.controller.start({ systemAudio: false });
  oldTrack.emit("ended"); oldRecorder.fail();
  assert.equal(h.controller.state, "recording");
  assert.equal(h.calls.recorders[1].stopCalls, 0);
  h.controller.dispose();
  stopped(nextDisplay);
});

test("page disposal releases resources; late stop does not resurrect unsaved data", async () => {
  const h = harness();
  await h.controller.start({ microphone: true });
  h.controller.dispose();
  stopped(h.display); stopped(h.mic);
  assert.equal(h.calls.contexts[0].closeCount, 1);
  assert.equal(h.calls.timers.size, 0);
  h.calls.recorders[0].finish(); await flush();
  assert.equal(h.controller.blob, null);
});
