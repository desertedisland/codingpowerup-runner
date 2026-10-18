// Start a shell command that must outlive this process. Used when the factory rebuilds itself: the
// rebuild stops the factory's own PM2 process, and PM2 kills a process's whole tree when it stops
// it. `setsid nohup ... &` inside a shell that then exits leaves the command re-parented to init,
// in its own session, so it is no longer in the API's tree. Output goes to a log file because
// nobody is left to read it. POSIX only; the droplet is Ubuntu.
import { spawn } from 'child_process';
import logger from '../../log/logger';
import { childEnv } from '../childEnv/childEnv';

// Single-quote a value for sh, so paths and commands pass through unchanged
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const startDetached = (command: string, cwd: string, logFile: string): void => {

  if (process.platform === 'win32') {
    throw new Error('startDetached needs a POSIX shell (setsid); it is meant for the droplet');
  }

  const launcher = `setsid nohup sh -c ${shellQuote(command)} > ${shellQuote(logFile)} 2>&1 < /dev/null &`;
  const shell = spawn('sh', ['-c', launcher], { cwd, env: childEnv(), stdio: 'ignore', detached: true });
  shell.unref();

  logger.info(`[process-detached] Started "${command}" in ${cwd}, logging to ${logFile}`);

};
