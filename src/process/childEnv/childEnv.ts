// The environment for a command the factory runs in a product checkout. The factory's own .env
// (loaded by `node --env-file` under PM2, by dotenv in dev) puts its port, database, JWT secret
// and tokens into process.env, and a child inherits all of it. A product rebuild then hands those
// to `pm2 start`, PM2 stores them as the product API's environment, and because neither
// --env-file nor dotenv overrides a variable that is already set, the product ran on the
// factory's port and database. So every key the factory's env files define is removed; PATH,
// HOME and the rest of the shell environment pass through.
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// The env files this process loaded: each --env-file in Node's own arguments, plus the .env in
// the working directory (factory-api/ under PM2 and npm run dev:api)
const ownEnvFiles = (execArgv: string[] = process.execArgv, cwd: string = process.cwd()): string[] => {
  const files: string[] = [];
  execArgv.forEach((arg, index) => {
    if (arg.startsWith('--env-file=')) {
      files.push(arg.slice('--env-file='.length));
    } else if (arg === '--env-file' && execArgv[index + 1]) {
      files.push(execArgv[index + 1]);
    }
  });
  files.push(path.join(cwd, '.env'));
  return [...new Set(files.map((file) => path.resolve(cwd, file)))];
};

// Key names only; a missing or unreadable file contributes none
export const envFileKeys = (files: string[]): Set<string> => {
  const keys = new Set<string>();
  files.forEach((file) => {
    try {
      Object.keys(dotenv.parse(fs.readFileSync(file))).forEach((key) => keys.add(key));
    } catch { /* no such file */ }
  });
  return keys;
};

let cachedKeys: Set<string> | undefined;

export const childEnv = (
  base: NodeJS.ProcessEnv = process.env,
  keys: Set<string> = (cachedKeys ??= envFileKeys(ownEnvFiles())),
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  Object.entries(base).forEach(([key, value]) => {
    if (!keys.has(key)) env[key] = value;
  });
  return env;
};

export const _ownEnvFilesForTest = ownEnvFiles;
