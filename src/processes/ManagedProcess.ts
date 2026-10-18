// A process the runner starts and owns: an application serving a preview, or anything else that
// must be stopped as a whole later. Started in its own process group so stopping it takes every
// child (npm, the API, Vite) with it; output kept as a rolling tail, so a crash can be explained.
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { childEnv } from '../process/childEnv/childEnv';
import logger from '../log/logger';

const OUTPUT_TAIL_CHARS = 20000;
const STOP_GRACE_MS = 5000;

export interface IManagedProcessOptions {
  id: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  label: string;
}

export type TProcessState = 'running' | 'exited' | 'stopped';

export class ManagedProcess extends EventEmitter {

  state: TProcessState = 'running';
  exitCode: number | null = null;
  readonly startedAt = new Date();
  readonly pid: number | undefined;

  private child: ChildProcess;
  private output = '';

  constructor(readonly options: IManagedProcessOptions) {

    super();

    // shell: true so `npm run x && npm run y` works; detached so the whole tree is one group
    this.child = spawn(options.command, {
      cwd: options.cwd,
      env: { ...childEnv(), ...(options.env || {}) },
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;

    const append = (chunk: Buffer) => { this.output = (this.output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS); };
    this.child.stdout?.on('data', append);
    this.child.stderr?.on('data', append);

    this.child.on('exit', (code) => {
      if (this.state === 'running') this.state = 'exited';
      this.exitCode = code;
      logger.info(`[process] ${options.label} (${options.id}) exited with ${code}`);
      this.emit('exit', code);
    });
    this.child.on('error', (err) => {
      this.output = `${this.output}\n${err.message}`.slice(-OUTPUT_TAIL_CHARS);
      if (this.state === 'running') this.state = 'exited';
      this.exitCode = -1;
      this.emit('exit', -1);
    });

    logger.info(`[process] ${options.label} (${options.id}) started as pid ${this.pid} in ${options.cwd}`);

  }

  outputTail(chars = 1500): string { return this.output.slice(-chars).trim(); }

  isRunning(): boolean { return this.state === 'running'; }

  // Stop the whole group: a polite signal, then a hard one
  async stop(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    await killGroup(this.pid, this.child);
    logger.info(`[process] ${this.options.label} (${this.options.id}) stopped`);
  }

}

// Kill a process group (or a bare pid): SIGTERM, a grace period, SIGKILL
export const killGroup = async (pid: number | undefined, child?: ChildProcess): Promise<void> => {

  if (!pid) return;

  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-pid, sig);
    } catch { /* already gone */ }
  };

  const exited = new Promise<void>((resolve) => {
    if (!child) { resolve(); return; }
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
  });

  signal('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS))]);
  if (!graceful) signal('SIGKILL');

};

// Whether a process group leader is still alive (for orphans from a previous run of the runner)
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
