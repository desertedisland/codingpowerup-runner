// What this machine can do, detected rather than assumed, and reported on every connect: git,
// Node, Docker, Playwright's browser, and whether Claude Code is installed and signed in.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IRunnerCapabilities } from '@yellowmelon/factory-global-types';
import { platform, tryRun } from '../platform/platform';

// Playwright keeps its browsers in a cache directory per OS; a chromium folder there is the
// browser the testing turns drive
const playwrightCacheDir = (): string => {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  switch (platform()) {
    case 'darwin': return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    case 'win32': return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
    default: return path.join(os.homedir(), '.cache', 'ms-playwright');
  }
};

const hasPlaywrightBrowser = (): boolean => {
  try {
    return fs.readdirSync(playwrightCacheDir()).some((entry) => entry.startsWith('chromium'));
  } catch {
    return false;
  }
};

// Claude Code is installed when `claude` answers, and signed in when a token or a credentials
// file is there. The subscription token (CLAUDE_CODE_OAUTH_TOKEN) is what the control plane's
// agent runs under; the credentials file is what `claude login` leaves behind.
const hasCodingAgent = async (): Promise<boolean> => {
  const version = await tryRun('claude', ['--version']);
  if (!version) return false;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'));
};

export const detectCapabilities = async (): Promise<IRunnerCapabilities> => {
  const [git, node, docker, codingAgent] = await Promise.all([
    tryRun('git', ['--version']),
    tryRun('node', ['--version']),
    tryRun('docker', ['--version']),
    hasCodingAgent(),
  ]);
  return {
    git: !!git,
    node: node ? node.replace(/^v/, '') : undefined,
    docker: !!docker,
    playwrightBrowser: hasPlaywrightBrowser(),
    codingAgent,
    platform: platform(),
  };
};
