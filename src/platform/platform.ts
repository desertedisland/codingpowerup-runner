// The per-OS layer: everything that differs between Linux, macOS and Windows lives here, so the
// rest of the runner is one body of code. Linux first; the others fill in as they are built.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type TPlatform = 'linux' | 'darwin' | 'win32';

export const platform = (): TPlatform => (os.platform() === 'win32' ? 'win32' : os.platform() === 'darwin' ? 'darwin' : 'linux');

// Where the runner keeps its config: ~/.codingpowerup on every platform (the directory the
// control plane's own LocalRunner reads too), overridable for tests and odd setups
export const configDirectory = (): string => process.env.CODINGPOWERUP_HOME || path.join(os.homedir(), '.codingpowerup');

export const configFilePath = (): string => process.env.FACTORY_RUNNER_CONFIG || path.join(configDirectory(), 'runner.json');

// Only the owner may read a file holding the credential
export const writePrivateFile = (file: string, contents: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  if (platform() !== 'win32') fs.chmodSync(file, 0o600);
};

// Run a program and return its trimmed stdout, or nothing when it is not there or fails
export const tryRun = async (command: string, args: string[], timeoutMs = 5000): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true });
    return stdout.toString().trim();
  } catch {
    return undefined;
  }
};

// "~/x" means the home directory; anything else is taken as given
export const expandHome = (candidate: string): string =>
  (candidate === '~' || candidate.startsWith('~/')) ? path.join(os.homedir(), candidate.slice(1)) : candidate;

export const hostname = (): string => os.hostname();
