// Local browser capability + UI lifecycle test. No real microphone or screen capture.
// Uses an already-installed Playwright module; adds no product dependency.
import http from "node:http";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ||
  "C:/Users/chikitwong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-output");
await mkdir(output, { recursive: true });
const allowed = new Map([["/recorder.html", "text/html"], ["/recorder.js", "text/javascript"], ["/recorder.css", "text/css"], ["/preview-fixture.webm", "video/webm"]]);
const previewFixture = path.resolve(root, "../output/2026-10-16_progress/Remote_Meetings_Demo_v2_zh.webm");
const server = http.createServer(async (req, res) => {
  if (!allowed.has(req.url)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": allowed.get(req.url) + "; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(await readFile(req.url === "/preview-fixture.webm" ? previewFixture : path.join(root, "public", req.url.slice(1))));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/recorder.html";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  const cspErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy|violates.*directive/.test(message.text())) cspErrors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById("record-capability").textContent.includes("正在检查"));
  const capabilities = await page.evaluate(() => ({
    userAgent: navigator.userAgent, secureContext: isSecureContext,
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
    MediaRecorder: typeof MediaRecorder,
    types: Object.fromEntries(["video/webm", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus"]
      .map((type) => [type, typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)])),
    speechRecognition: typeof (window.SpeechRecognition || window.webkitSpeechRecognition),
    note: "Capability inspection only. No real screen/microphone authorization or live speech recognition was requested."
  }));
  assert.equal(capabilities.MediaRecorder, "function");
  assert.equal(capabilities.getDisplayMedia, "function");
  assert(Object.values(capabilities.types).some(Boolean));
  await page.screenshot({ path: path.join(output, "recorder-idle-capability.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "recorder-narrow-capability.png"), fullPage: true });
  const syntheticEncode = await page.evaluate(async () => {
    const { LocalRecorder } = await import("/recorder.js");
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    canvas.style.position = "fixed"; canvas.style.top = "0"; canvas.style.left = "0";
    document.body.append(canvas);
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#235c46"; paint.fillRect(0, 0, 320, 180);
    paint.fillStyle = "white"; paint.font = "18px sans-serif";
    paint.fillText("Synthetic recorder test", 30, 90);
    const canvasStream = canvas.captureStream(0);
    const capture = new LocalRecorder({
      isSecureContext, MediaRecorder, MediaStream, AudioContext, Blob, performance,
      setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
      navigator: { mediaDevices: { getDisplayMedia: async () => canvasStream } }
    });
    await capture.start({ systemAudio: false, microphone: false });
    if (capture.state !== "recording") throw new Error(capture.message);
    const nativeEvents = [];
    capture.current.recorder.addEventListener("error", (e) => nativeEvents.push({ type: "error", name: e.error?.name, message: e.error?.message }));
    capture.current.recorder.addEventListener("dataavailable", (e) => nativeEvents.push({ type: "data", size: e.data.size }));
    capture.current.recorder.addEventListener("stop", () => nativeEvents.push({ type: "stop" }));
    let frame = 0;
    const animation = setInterval(() => {
      paint.fillStyle = "#235c46"; paint.fillRect(0, 110, 320, 70);
      paint.fillStyle = "white"; paint.fillText("Frame " + (++frame), 30, 140);
      canvasStream.getVideoTracks()[0].requestFrame();
    }, 75);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    clearInterval(animation);
    capture.stop();
    const deadline = performance.now() + 5000;
    while (capture.state === "finalizing" && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!capture.blob?.size) {
      const message = capture.message;
      capture.dispose(); canvas.remove();
      return { passed: false, input: "generated canvas; no physical screen or microphone",
        bytes: 0, message, nativeEvents, note: "Headless canvas encoding did not provide data; physical capture remains untested." };
    }
    const preview = document.getElementById("record-preview");
    const objectUrl = URL.createObjectURL(capture.blob);
    try {
      const loaded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Blob preview did not load")), 5000);
        preview.addEventListener("loadeddata", () => { clearTimeout(timeout); resolve(); }, { once: true });
        preview.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Blob preview failed")); }, { once: true });
      });
      preview.src = objectUrl; preview.hidden = false;
      await loaded;
      return { passed: true, input: "generated canvas; no physical screen or microphone",
        mimeType: capture.blob.type, bytes: capture.blob.size,
        previewWidth: preview.videoWidth, previewHeight: preview.videoHeight,
        allTracksStopped: canvasStream.getTracks().every((t) => t.readyState === "ended") };
    } finally {
      preview.removeAttribute("src"); preview.load(); URL.revokeObjectURL(objectUrl);
      capture.dispose();
      canvas.remove();
    }
  });
  if (syntheticEncode.passed) {
    assert(syntheticEncode.bytes > 0);
    assert.equal(syntheticEncode.previewWidth, 320);
    assert.equal(syntheticEncode.previewHeight, 180);
    assert.equal(syntheticEncode.allTracksStopped, true);
  }
  const blobPreview = await page.evaluate(async () => {
    const response = await fetch("/preview-fixture.webm");
    if (!response.ok) throw new Error("Existing preview fixture unavailable");
    const bytes = await response.arrayBuffer();
    const blob = new Blob([bytes], { type: "video/webm" });
    const objectUrl = URL.createObjectURL(blob);
    const video = document.getElementById("record-preview");
    try {
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Existing WebM Blob preview timeout")), 5000);
        video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Existing WebM Blob preview failed")); }, { once: true });
      });
      video.src = objectUrl; video.hidden = false; await loaded;
      return { passed: true, input: "existing 2026-10-16 demo WebM, reused only to test Blob playback and CSP",
        bytes: blob.size, width: video.videoWidth, height: video.videoHeight };
    } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl); }
  });
  assert(blobPreview.width > 0 && blobPreview.height > 0);
  await page.close();

  const mock = await browser.newPage();
  mock.on("pageerror", (error) => errors.push(error.message));
  await mock.addInitScript(() => {
    class Track extends EventTarget {
      constructor(kind) { super(); this.kind = kind; this.readyState = "live"; this.stopCount = 0; }
      stop() { this.readyState = "ended"; this.stopCount++; }
    }
    class Stream {
      constructor(tracks = []) { this.tracks = tracks; }
      getTracks() { return [...this.tracks]; }
      getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
      getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
    }
    const fixture = { display: new Stream([new Track("video"), new Track("audio")]),
      mic: new Stream([new Track("audio")]), contexts: [], recorders: [] };
    class Context {
      constructor() { this.state = "suspended"; this.closed = 0; fixture.contexts.push(this); }
      createMediaStreamDestination() { this.destination = new Stream([new Track("audio")]); return { stream: this.destination, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; this.closed++; }
    }
    class Recorder extends EventTarget {
      static isTypeSupported(type) { return type.startsWith("video/webm"); }
      constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType; this.state = "inactive"; fixture.recorders.push(this); }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; }
      chunk(text) { const event = new Event("dataavailable"); event.data = new Blob([text]); this.dispatchEvent(event); }
      finish() { this.chunk("FINAL"); this.dispatchEvent(new Event("stop")); }
    }
    Object.defineProperty(navigator, "mediaDevices", { value: {
      getDisplayMedia: async () => fixture.display, getUserMedia: async () => fixture.mic
    }, configurable: true });
    window.MediaStream = Stream;
    window.MediaRecorder = Recorder;
    window.AudioContext = Context;
    window.__recorderFixture = fixture;
  });
  await mock.goto(url);
  await mock.locator("#record-microphone").check();
  await mock.locator("#record-start").click();
  await mock.waitForFunction(() => document.getElementById("record-status").textContent.includes("正在录制"));
  const leavePrevented = await mock.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(leavePrevented, true);
  await mock.evaluate(() => window.__recorderFixture.recorders[0].chunk("FIRST-"));
  await mock.locator("#record-stop").click();
  assert(await mock.locator("#record-save").isDisabled());
  assert.match(await mock.locator("#record-status").textContent(), /最后一段/);
  const released = await mock.evaluate(() => {
    const f = window.__recorderFixture;
    return { stopped: [...f.display.getTracks(), ...f.mic.getTracks(), ...f.contexts[0].destination.getTracks()].every((t) => t.readyState === "ended"),
      contextCloseCount: f.contexts[0].closed };
  });
  assert.equal(released.stopped, true);
  assert.equal(released.contextCloseCount, 1);
  await mock.evaluate(() => window.__recorderFixture.recorders[0].finish());
  await mock.waitForFunction(() => !document.getElementById("record-save").disabled);
  const [download] = await Promise.all([mock.waitForEvent("download"), mock.locator("#record-save").click()]);
  assert(download.suggestedFilename().endsWith(".webm"));
  assert.equal((await readFile(await download.path())).toString(), "FIRST-FINAL");
  assert.match(await mock.locator("#record-status").textContent(), /已请求浏览器下载/);
  assert.deepEqual(errors, []);
  assert.deepEqual(cspErrors, []);
  const report = { ...capabilities, checkedAt: new Date().toISOString(),
    mockUi: { permissions: "doubles; no physical capture", resourcesReleased: released,
      beforeUnloadHandlerPreventsLeaving: true, nativeBeforeUnloadDialogValidated: false,
      saveDisabledUntilFinalStop: true, downloadedBytesIncludeFinalChunk: true },
    syntheticEncode, blobPreview, blobPreviewCspErrors: cspErrors,
    realAudioVideoCaptureValidated: false, pageErrors: errors };
  await writeFile(path.join(output, "recorder-browser-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
