// The three commands: connect (pair with a pairing code and write runner.json), start (connect
// and stay connected, reporting the machine), status (what runner.json says and whether the
// server still knows this runner).
import os from 'os';
import { IRunnerPairRequest, IRunnerPairResponse, IRunnerSummary, RUNNER_PROTOCOL_VERSION } from '@yellowmelon/factory-global-types';
import { readRunnerConfig, requireServer, writeRunnerConfig } from '../config/RunnerConfig';
import { detectCapabilities } from '../capabilities/capabilities';
import { describeProjects } from '../repositories/RepositoryRegistry';
import { RunnerConnection } from '../connection/RunnerConnection';
import { configFilePath, hostname, platform } from '../platform/platform';
import { JobDispatcher } from '../jobs/JobDispatcher';
import { JobLedger } from '../jobs/JobLedger';
import { heavyQueueStatus, queueEvents } from '../queue/HeavyWorkQueue';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: RUNNER_VERSION } = require('../../package.json') as { version: string };

export const runnerVersion = (): string => RUNNER_VERSION;

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export interface IConnectArguments {
  server: string;
  code: string;
  name?: string;
}

// Pair: redeem the code for a credential and write it into runner.json beside the projects
export const connect = async ({ server, code, name }: IConnectArguments): Promise<void> => {

  const serverUrl = trimSlash(server);
  const runnerName = name || os.hostname();
  const body: IRunnerPairRequest = { code, name: runnerName, version: RUNNER_VERSION, protocolVersion: RUNNER_PROTOCOL_VERSION, platform: platform(), hostname: hostname() };

  const response = await fetch(`${serverUrl}/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${(await response.text()).trim()}`);

  const paired = (await response.json()) as IRunnerPairResponse;
  const config = readRunnerConfig();
  writeRunnerConfig({
    ...config,
    server: { url: serverUrl, runnerId: paired.runnerId, credential: paired.credential, organisationId: paired.organisationId, organisationName: paired.organisationName, name: runnerName },
  });

  console.log(`Paired with ${paired.organisationName} as "${runnerName}" (runner ${paired.runnerId}).`);
  console.log(`The credential is in ${configFilePath()}; keep that file private.`);
  console.log(`Start the runner with: codingpowerup-runner start`);
  if (config.projects.length === 0) console.log(`No projects are listed in ${configFilePath()} yet; add them under "projects" (key, path, checkCommand...).`);

};

// Start: connect and stay connected until stopped, reporting the machine and the checkouts
export const start = async (): Promise<RunnerConnection> => {

  const config = readRunnerConfig();
  const server = requireServer(config);

  log(`codingpowerup-runner ${RUNNER_VERSION} on ${platform()} (${hostname()}), ${config.projects.length} project(s) configured`);
  if (config.capacity?.concurrency && !process.env.FACTORY_HEAVY_CONCURRENCY) process.env.FACTORY_HEAVY_CONCURRENCY = String(config.capacity.concurrency);

  const ledger = new JobLedger();
  let dispatcher: JobDispatcher | null = null;

  const connection = new RunnerConnection({
    serverUrl: server.url,
    credential: server.credential,
    runnerId: server.runnerId,
    version: RUNNER_VERSION,
    platform: platform(),
    hostname: hostname(),
    capabilities: detectCapabilities,
    projects: () => describeProjects(readRunnerConfig().projects),
    activeJobs: () => (dispatcher ? dispatcher.activeJobIds() : []),
    heldJobs: () => (dispatcher ? dispatcher.heldJobs() : ledger.all()),
    queue: heavyQueueStatus,
    log,
  });

  dispatcher = new JobDispatcher(connection, ledger, { serverUrl: server.url, credential: server.credential });
  queueEvents.on('change', (queue) => connection.reportQueue(queue));

  connection.on('state', (state) => log(`State: ${state}`));
  connection.start();

  const shutdown = (signal: string) => {
    log(`${signal} received; stopping`);
    connection.stop(signal);
    setTimeout(() => process.exit(0), 200);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return connection;

};

// Status: the local view, and the server's when it can be reached
export const status = async (): Promise<void> => {

  const config = readRunnerConfig();
  console.log(`Config: ${configFilePath()}`);
  console.log(`Projects: ${config.projects.length === 0 ? 'none' : config.projects.map((project) => `${project.key} (${project.path})`).join(', ')}`);

  if (!config.server) {
    console.log('Not paired. Run: codingpowerup-runner connect --server <url> --code <code>');
    return;
  }

  console.log(`Server: ${config.server.url}`);
  console.log(`Runner: "${config.server.name}" (${config.server.runnerId})${config.server.organisationName ? ` in ${config.server.organisationName}` : ''}`);

  try {
    const response = await fetch(`${config.server.url}/runner/me`, { headers: { Authorization: `Bearer ${config.server.credential}` } });
    if (response.status === 401) { console.log('The server does not accept this credential any more (revoked?). Pair again.'); return; }
    if (!response.ok) { console.log(`The server answered ${response.status}: ${(await response.text()).trim()}`); return; }
    const me = (await response.json()) as IRunnerSummary;
    console.log(`Server says: ${me.status}${me.lastSeenAt ? `, last seen ${new Date(me.lastSeenAt).toLocaleString()}` : ''}`);
  } catch (err) {
    console.log(`Could not reach the server: ${(err as Error).message}`);
  }

  const capabilities = await detectCapabilities();
  console.log(`This machine: git ${capabilities.git ? 'yes' : 'no'}, node ${capabilities.node || 'no'}, docker ${capabilities.docker ? 'yes' : 'no'}, browser ${capabilities.playwrightBrowser ? 'yes' : 'no'}, Claude Code ${capabilities.codingAgent ? 'signed in' : 'not signed in'}`);

};
