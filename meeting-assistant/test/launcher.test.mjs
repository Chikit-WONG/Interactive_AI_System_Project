import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testOut = path.join(project, 'test-output');
const stub = `import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.loadEnvFile(new URL('.env', import.meta.url));
const directory = path.dirname(fileURLToPath(import.meta.url));
const installationId = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 24);
const session = { id: randomUUID(), changes: 0 };
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ appId: 'partial-participation-meeting-assistant', installationId, pid: process.pid, version: 'test-stub', launchId: process.env.MEETING_LAUNCH_ID || null }));
  if (req.url === '/test/bump') session.changes++;
  res.end(JSON.stringify(session));
});
server.on('error', () => process.exit(1));
server.listen(Number(process.env.PORT || 8765), '127.0.0.1');
`;

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function invoke(directory, command, { env: extraEnv = {}, flags = [] } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.PORT;
    delete env.MEETING_LAUNCH_ID;
    const child = spawn(process.execPath, [path.join(directory, 'launcher.mjs'), command, ...flags], {
      cwd: directory, windowsHide: true, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Test launcher exceeded 15 seconds.')); }, 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function fixture(t) {
  await mkdir(testOut, { recursive: true });
  const directory = await mkdtemp(path.join(testOut, 'launcher-test-'));
  const port = await freePort();
  const pids = new Set();
  await copyFile(path.join(project, 'launcher.mjs'), path.join(directory, 'launcher.mjs'));
  await writeFile(path.join(directory, 'server.mjs'), stub, 'utf8');
  await writeFile(path.join(directory, '.env'), `PORT=${port}\nDEEPSEEK_API_KEY=TEST_ONLY_DO_NOT_PRINT\n`, 'utf8');
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 100));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), testOut);
    assert.ok(path.basename(resolved).startsWith('launcher-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const metadataPath = path.join(directory, 'logs/launcher-instance.json');
  const get = async endpoint => (await (await fetch(`http://127.0.0.1:${port}${endpoint}`)).json());
  async function start(options = {}) {
    const result = await invoke(directory, 'start', options);
    if (result.code === 0) { const value = JSON.parse(result.stdout); pids.add(value.pid); }
    return result;
  }
  return { directory, port, start, get, metadataPath, pids };
}

test('launcher cold start survives launcher exit; repeated launch reuses state and managed stop succeeds', async t => {
  const f = await fixture(t);
  const cold = await f.start({ flags: ['--recorder'] });
  assert.equal(cold.code, 0, cold.stderr);
  assert.equal(cold.stderr, '');
  const first = JSON.parse(cold.stdout);
  assert.equal(first.reused, false);
  assert.equal(first.url, `http://127.0.0.1:${f.port}/recorder.html`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const ready = await f.get('/api/health');
  assert.equal(ready.pid, first.pid, 'daemon is alive after launcher process has exited');
  const metadata = JSON.parse(await readFile(f.metadataPath, 'utf8'));
  assert.equal(metadata.launchId, ready.launchId);
  assert.equal(metadata.pid, ready.pid);
  const changed = await f.get('/test/bump');
  const again = await f.start();
  assert.equal(again.code, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.deepEqual(await f.get('/api/state'), changed, 'reopening does not reset the running session');
  assert.equal((cold.stdout + cold.stderr + again.stdout + JSON.stringify(metadata)).includes('TEST_ONLY_DO_NOT_PRINT'), false);
  const stopped = await invoke(f.directory, 'stop');
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  const repeated = await invoke(f.directory, 'stop');
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).stopped, false);
});

test('concurrent starts share one daemon and only the winning process publishes metadata', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.start(), f.start(), f.start()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const values = results.map(result => JSON.parse(result.stdout));
  assert.equal(new Set(values.map(value => value.pid)).size, 1);
  assert.equal(values.filter(value => !value.reused).length, 1);
  const current = await f.get('/api/health');
  const metadata = JSON.parse(await readFile(f.metadataPath, 'utf8'));
  assert.equal(metadata.pid, current.pid);
  assert.equal(metadata.launchId, current.launchId);
  assert.equal((await invoke(f.directory, 'stop')).code, 0);
});

test('a foreign service on the configured port is neither replaced nor stopped', async t => {
  const f = await fixture(t);
  const other = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ appId: 'partial-participation-meeting-assistant', installationId: 'other-installation', pid: process.pid, version: 'test', launchId: randomUUID() }));
  });
  await new Promise(resolve => other.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { other.closeAllConnections(); other.close(resolve); }));
  for (const command of ['start', 'stop']) {
    const rejected = await invoke(f.directory, command);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /Port.*another service/);
    assert.equal((await f.get('/api/health')).installationId, 'other-installation');
  }
});

test('stop refuses a valid service when stored launch nonce does not match', async t => {
  const f = await fixture(t);
  const started = await f.start();
  assert.equal(started.code, 0, started.stderr);
  const original = JSON.parse(await readFile(f.metadataPath, 'utf8'));
  await writeFile(f.metadataPath, JSON.stringify({ ...original, launchId: randomUUID() }), 'utf8');
  const refused = await invoke(f.directory, 'stop');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /does not match the instance recorded by this launcher/);
  assert.equal((await f.get('/api/health')).pid, original.pid);
  await writeFile(f.metadataPath, JSON.stringify(original), 'utf8');
  assert.equal((await invoke(f.directory, 'stop')).code, 0);
});

test('environment PORT overrides the local .env port without exposing configuration', async t => {
  const f = await fixture(t);
  const override = await freePort();
  const result = await f.start({ env: { PORT: String(override) } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).url, `http://127.0.0.1:${override}/`);
  const metadata = JSON.parse(await readFile(f.metadataPath, 'utf8'));
  assert.equal(metadata.port, override);
  assert.equal((await invoke(f.directory, 'stop', { env: { PORT: String(override) } })).code, 0);
  const invalid = await invoke(f.directory, 'start', { env: { PORT: 'invalid' } });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Invalid PORT/);
  assert.equal(invalid.stdout, '');
});

test('a server startup failure returns promptly and prints a log path, not log contents', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'server.mjs'), "console.error('TEST_PRIVATE_LOG_CONTENT'); process.exit(2);\n", 'utf8');
  const began = Date.now();
  const failed = await f.start();
  assert.equal(failed.code, 1);
  assert(Date.now() - began < 5000);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /startup log/);
  assert.equal(failed.stderr.includes('TEST_PRIVATE_LOG_CONTENT'), false);
  assert.equal(failed.stderr.includes('TEST_ONLY_DO_NOT_PRINT'), false);
});
