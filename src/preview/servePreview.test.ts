// Serving a preview against a real little application: it starts on free ports from the range,
// is ready when its URL answers, is stopped as a whole group, a crash and a timeout are
// explained, one per project, and a leftover from a previous run is cleaned up.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ProcessRegistry } from '../processes/ProcessRegistry';
import { isAlive } from '../processes/ManagedProcess';
import { ServedPreviews } from './servePreview';

const TEST_HOME = path.join(os.tmpdir(), `cpr-serve-test-${process.pid}`);
const APP_DIR = path.join(TEST_HOME, 'app');
const REGISTRY = path.join(TEST_HOME, 'processes.json');

// A tiny application: an http server on CLIENT_PORT that answers once $READY_AFTER_MS have passed
const APP = `
const http = require('http');
const start = Date.now();
const delay = Number(process.env.READY_AFTER_MS || 0);
if (process.env.CRASH) { console.error('boom: cannot start'); process.exit(3); }
const server = http.createServer((req, res) => { res.statusCode = 200; res.end('hello from ' + process.env.CLIENT_PORT); });
setTimeout(() => server.listen(Number(process.env.CLIENT_PORT), '127.0.0.1', () => console.log('listening')), delay);
`;

const project = { key: 'sample', name: 'Sample', defaultBranch: 'main' };

jest.mock('../repositories/projectConfig', () => ({
  localProjectConfig: (candidate: { key: string }) => (candidate.key === 'sample'
    ? { key: 'sample', path: process.env.CPR_TEST_APP_DIR, checkCommand: 'true', startCommand: `node ${process.env.CPR_TEST_APP_DIR}/app.js`, readiness: { url: 'http://127.0.0.1:${CLIENT_PORT}/', timeoutSeconds: 5, intervalMs: 100 } }
    : undefined),
  resolveProjectPath: () => process.env.CPR_TEST_APP_DIR,
  listLocalProjectConfigs: () => [],
}));
jest.mock('../config/RunnerConfig', () => ({ readRunnerConfig: () => ({ projects: [], capacity: { portRange: { from: 21500, to: 21520 }, previewIdleMinutes: 30 } }) }));
jest.mock('../git/Workspace/Workspace', () => ({ headShortSha: async () => 'abc1234' }));
jest.mock('../git/Worktrees/Worktrees', () => ({ linkCheckoutFiles: async () => undefined, releasePreviewPathFor: () => '', prepareReleasePreview: async () => undefined }));

let registry: ProcessRegistry;
let served: ServedPreviews;

const start = (label: string, extraEnv: Record<string, string> = {}) => {
  Object.assign(process.env, extraEnv);
  return served.start({ project, source: { kind: 'checkout' }, label, strategy: 'serve', previewId: `p-${label}` });
};

const answers = async (url: string): Promise<string | null> => {
  try { return await (await fetch(url)).text(); } catch { return null; }
};

beforeAll(() => {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, 'app.js'), APP);
  process.env.CPR_TEST_APP_DIR = APP_DIR;
  process.env.CODINGPOWERUP_HOME = TEST_HOME;
});

beforeEach(() => {
  delete process.env.CRASH; delete process.env.READY_AFTER_MS;
  registry = new ProcessRegistry(REGISTRY);
  served = new ServedPreviews(registry);
});

afterEach(async () => { await served.stopAll('test over'); await registry.stopAll(); });
afterAll(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); });

describe('a served preview', () => {

  it('starts the application on ports from the range, waits until it answers, and stops it as a group', async () => {

    const stopped: string[] = [];
    served.onStopped((payload) => stopped.push(payload.reason));

    const result = await start('s1');
    expect(result.ports.api).toBeGreaterThanOrEqual(21500);
    expect(result.ports.client).toBeGreaterThan(result.ports.api);
    expect(result.localUrl).toEqual(`http://127.0.0.1:${result.ports.client}`);
    expect(result.reachableUrl).toBeUndefined(); // no reachable host configured
    expect(result.commit).toEqual('abc1234');
    expect(await answers(result.localUrl)).toEqual(`hello from ${result.ports.client}`);

    const pid = registry.get(result.processId).pid;
    expect(isAlive(pid)).toBe(true);
    expect(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).map((entry: { id: string }) => entry.id)).toEqual([result.processId]);

    expect(await served.stop('p-s1', 'closed')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await answers(result.localUrl)).toBeNull();
    expect(stopped).toEqual(['closed']);
    expect(JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))).toEqual([]);

  });

  it('one per project: a second preview replaces the first on new ports', async () => {
    const first = await start('a');
    const firstPid = registry.get(first.processId).pid;
    const second = await start('b');
    // The first process is gone (its ports may well be reused by the second), the second answers
    expect(isAlive(firstPid)).toBe(false);
    expect(await answers(second.localUrl)).toMatch(/hello/);
    expect(served.all().map((preview) => preview.previewId)).toEqual(['p-b']);
    expect(registry.all().filter((managed) => managed.isRunning()).map((managed) => managed.options.id)).toEqual([second.processId]);
  });

  it('an application started beside the preview (a test batch) takes its own ports and leaves the preview alone', async () => {
    const preview = await start('p');
    const forTests = await served.start({ project, source: { kind: 'checkout' }, label: 'tests', strategy: 'serve', previewId: 'app-1' }, undefined, { exclusive: false, idles: false });
    expect(forTests.ports.client).not.toEqual(preview.ports.client);
    expect(await answers(preview.localUrl)).toMatch(/hello/);
    expect(await answers(forTests.localUrl)).toMatch(/hello/);
    expect(served.byProject('sample').previewId).toEqual('p-p');
    expect(served.all()).toHaveLength(2);
    await served.stop('app-1', 'batch done', false);
    expect(await answers(preview.localUrl)).toMatch(/hello/);
  });

  it('explains a crash at startup with the output, and a readiness timeout', async () => {
    await expect(start('crash', { CRASH: '1' })).rejects.toThrow(/exited before it was ready \(code 3\):[\s\S]*boom: cannot start/);
    expect(served.all()).toEqual([]);
    delete process.env.CRASH;
    await expect(start('slow', { READY_AFTER_MS: '20000' })).rejects.toThrow(/did not answer at http:\/\/127\.0\.0\.1:\d+\/ within 5 s/);
    expect(registry.all().every((managed) => !managed.isRunning())).toBe(true);
  });

  it('tells its listeners when the application dies on its own', async () => {
    const stopped: string[] = [];
    served.onStopped((payload) => stopped.push(payload.reason));
    const result = await start('dies');
    process.kill(registry.get(result.processId).pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped[0]).toMatch(/the application exited/);
    expect(served.all()).toEqual([]);
  });

});

describe('orphans', () => {

  it('a process recorded by a previous run and still alive is stopped at startup', async () => {

    const orphan = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    fs.writeFileSync(REGISTRY, JSON.stringify([{ id: 'old', pid: orphan.pid, label: 'old app', cwd: '/', startedAt: new Date().toISOString() }]));
    expect(isAlive(orphan.pid)).toBe(true);

    const fresh = new ProcessRegistry(REGISTRY);
    expect(await fresh.cleanUpOrphans()).toEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(orphan.pid)).toBe(false);
    expect(JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))).toEqual([]);

  });

});
