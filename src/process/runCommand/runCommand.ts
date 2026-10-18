// Run a shell command in a directory and capture its combined output. Used for the check
// command in a session checkout. Output is capped so a chatty build cannot flood memory
// or Telegram; the tail is what matters when something fails.
import { spawn } from 'child_process';
import logger from '../../log/logger';
import { childEnv } from '../childEnv/childEnv';

export interface ICommandResult {
  command: string;
  exitCode: number;
  output: string;     // last maxOutputChars of stdout + stderr, interleaved
  durationMs: number;
  timedOut: boolean;
}

interface IRunOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;

// Kill the whole process tree: npm spawns children that would otherwise outlive a timeout
const killTree = (pid: number): void => {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
};

export const runCommand = (command: string, cwd: string, options: IRunOptions = {}): Promise<ICommandResult> => {

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const started = Date.now();

  logger.info(`[cmd-run] ${command} (in ${cwd})`);

  return new Promise((resolve) => {

    let output = '';
    let timedOut = false;

    // shell: true so `npm run x && npm run y` works the same on Windows and Linux. childEnv keeps
    // the factory's own .env out of the product's build and its PM2 process
    const child = spawn(command, { cwd, env: childEnv(), shell: true, windowsHide: true, detached: process.platform !== 'win32' });

    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-maxOutputChars);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`[cmd-timeout] ${command} exceeded ${timeoutMs}ms, killing`);
      killTree(child.pid);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? -1 : (code ?? -1);
      logger.info(`[cmd-done] ${command} exited ${exitCode} after ${Date.now() - started}ms`);
      resolve({ command, exitCode, output, durationMs: Date.now() - started, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ command, exitCode: -1, output: `${output}\n${err.message}`, durationMs: Date.now() - started, timedOut });
    });

  });

};
