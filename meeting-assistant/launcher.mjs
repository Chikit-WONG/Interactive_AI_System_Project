import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ID = 'partial-participation-meeting-assistant';
const directory = path.dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class LauncherError extends Error {}

// This deliberately checks only this service's identity, not its API-key configuration.
// Requests use node:http directly so environment proxy settings cannot reroute loopback.
function health(port, installationId, timeoutMs = 800) {
  return new Promise(resolve => {
    let finished = false;
    const finish = result => { if (!finished) { finished = true; resolve(result); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish({ kind: 'conflict' });
        return;
      }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 8192) { finish({ kind: 'conflict' }); request.destroy(); }
      });
      response.on('error', () => finish({ kind: 'conflict' }));
      response.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (value.appId !== APP_ID || value.installationId !== installationId ||
              !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
              typeof value.version !== 'string' || value.version.length > 100 ||
              (value.launchId != null && (typeof value.launchId !== 'string' || value.launchId.length > 100))) {
            return finish({ kind: 'conflict' });
          }
          finish({ kind: 'ready', value: {
            appId: value.appId, installationId: value.installationId, pid: value.pid,
            version: value.version, launchId: value.launchId ?? null
          } });
        } catch { finish({ kind: 'conflict' }); }
      });
    });
    request.setTimeout(timeoutMs, () => { finish({ kind: 'conflict' }); request.destroy(); });
    request.on('error', error => finish({ kind: error.code === 'ECONNREFUSED' ? 'absent' : 'conflict' }));
  });
}

function sameInstance(a, b) {
  return a?.installationId === b?.installationId && a?.pid === b?.pid &&
    typeof a?.launchId === 'string' && a.launchId.length > 0 && a.launchId === b?.launchId;
}

async function readMetadata(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); } catch { return null; }
}

async function writeMetadata(filename, value) {
  const temporary = `${filename}.${value.launchId}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function runLauncher(command, { recorder = false, projectDirectory = directory } = {}) {
  if (!['start', 'stop'].includes(command)) throw new LauncherError('Usage: node launcher.mjs start|stop [--recorder]');
  const project = path.resolve(projectDirectory);
  const envFile = path.join(project, '.env');
  try { if (existsSync(envFile)) process.loadEnvFile(envFile); }
  catch { throw new LauncherError('Cannot read local configuration. Check the .env format and file permissions.'); }
  // Exactly the server's port semantics: existing environment wins, then .env, then 8765.
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LauncherError('Invalid PORT: use an integer between 1024 and 65535.');
  }
  const installationId = createHash('sha256').update(project).digest('hex').slice(0, 24);
  const url = `http://127.0.0.1:${port}/${recorder ? 'recorder.html' : ''}`;
  const logs = path.join(project, 'logs');
  const metadataPath = path.join(logs, 'launcher-instance.json');
  const conflict = () => new LauncherError(`Port ${port} is occupied by another service or its identity cannot be verified. No existing process was stopped. Check the port configuration.`);
  const initial = await health(port, installationId);
  if (initial.kind === 'conflict') throw conflict();

  if (command === 'stop') {
    if (initial.kind === 'absent') return { url, stopped: false, running: false };
    const metadata = await readMetadata(metadataPath);
    if (!sameInstance(initial.value, metadata) || metadata.port !== port ||
        typeof metadata.startedAt !== 'string' || !Number.isFinite(Date.parse(metadata.startedAt))) {
      throw new LauncherError('The service does not match the instance recorded by this launcher. Stop was refused. Exit it through its original service window.');
    }
    // Recheck identity after reading disk. Never kill a PID supplied by metadata alone.
    const current = await health(port, installationId);
    if (current.kind !== 'ready' || !sameInstance(current.value, initial.value)) {
      throw new LauncherError('The service instance changed during verification. Nothing was stopped. Try again.');
    }
    try { process.kill(current.value.pid, 'SIGTERM'); }
    catch (error) {
      if (error.code !== 'ESRCH') throw new LauncherError('Cannot stop this background service. Check processes for the current user; do not retry as administrator.');
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const after = await health(port, installationId, 500);
      if (after.kind !== 'ready' || !sameInstance(after.value, current.value)) {
        // Keep the small historical metadata file; start replaces it only after its own child is ready.
        return { url, stopped: true, running: after.kind === 'ready', pid: current.value.pid };
      }
      await pause(100);
    }
    throw new LauncherError('Stop was requested, but service exit has not yet been confirmed. Check again shortly.');
  }

  if (initial.kind === 'ready') {
    return { url, reused: true, running: true, pid: initial.value.pid, version: initial.value.version };
  }
  const launchId = randomUUID();
  const logPath = path.join(logs, `server-${launchId}.log`);
  let output, child, spawnError = false;
  try {
    await mkdir(logs, { recursive: true });
    output = await open(logPath, 'wx', 0o600);
    child = spawn(process.execPath, [path.join(project, 'server.mjs')], {
      cwd: project, detached: true, windowsHide: true,
      stdio: ['ignore', output.fd, output.fd],
      env: { ...process.env, MEETING_LAUNCH_ID: launchId }
    });
    child.on('error', () => { spawnError = true; });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    await output.close();
    output = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const status = await health(port, installationId, Math.min(800, deadline - Date.now()));
      if (status.kind === 'ready') {
        if (status.value.pid === child.pid && status.value.launchId === launchId) {
          await writeMetadata(metadataPath, {
            schemaVersion: 'meeting-launcher.v1', installationId, pid: child.pid,
            launchId, startedAt: new Date().toISOString(), port, logPath
          });
          return { url, reused: false, running: true, pid: child.pid, version: status.value.version };
        }
        // Another simultaneous launch won the port. Only its launcher may publish
        // its metadata. Discard this attempt's own child; never touch the winner.
        if (child.exitCode === null && child.signalCode === null) child.kill();
        return { url, reused: true, running: true, pid: status.value.pid, version: status.value.version };
      }
      if (status.kind === 'conflict') throw conflict();
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      await pause(150);
    }
    throw new LauncherError(`The background service did not become ready. See the startup log: ${logPath}`);
  } catch (error) {
    // This reference is the child we just spawned, never an arbitrary occupied-port PID.
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(`Background startup failed. Check directory permissions or the startup log: ${logPath}`);
  } finally { if (output) await output.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, ...flags] = process.argv.slice(2);
    if (flags.some(flag => flag !== '--recorder') || new Set(flags).size !== flags.length) {
      throw new LauncherError('Usage: node launcher.mjs start|stop [--recorder]');
    }
    console.log(JSON.stringify(await runLauncher(command, { recorder: flags.includes('--recorder') })));
  } catch (error) {
    console.error(error instanceof LauncherError ? error.message : 'The launcher could not complete the operation. Check the local runtime.');
    process.exitCode = 1;
  }
}
