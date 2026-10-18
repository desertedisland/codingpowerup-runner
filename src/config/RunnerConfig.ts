// runner.json: the server this runner belongs to, its credential, and the projects on this
// machine (where each checkout is and which commands check, build and start it). The projects
// part is the shape the control plane's LocalRunner reads (IRunnerProjectConfig); `connect`
// writes the server part.
import fs from 'fs';
import path from 'path';
import { IRunnerProjectConfig } from '@yellowmelon/factory-global-types';
import { configFilePath, expandHome, writePrivateFile } from '../platform/platform';

export interface IRunnerServerConfig {
  url: string;          // the control plane's API origin, e.g. https://devapi.yellowmelon.co
  runnerId: string;
  credential: string;   // shown once at pairing; this file is the only copy
  organisationId?: string;
  organisationName?: string;
  name: string;         // what the Runners page calls this runner
}

export interface IRunnerConfigFile {
  server?: IRunnerServerConfig;
  projects: IRunnerProjectConfig[];
}

export class RunnerConfigError extends Error {}

export const readRunnerConfig = (file: string = configFilePath()): IRunnerConfigFile => {

  if (!fs.existsSync(file)) return { projects: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new RunnerConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }

  // The early shape was a bare array of projects
  const config: IRunnerConfigFile = Array.isArray(parsed) ? { projects: parsed as IRunnerProjectConfig[] } : (parsed as IRunnerConfigFile);
  if (!Array.isArray(config.projects)) config.projects = [];

  config.projects.forEach((project) => {
    if (!project.key || !project.path || !project.checkCommand) {
      throw new RunnerConfigError(`${file}: every project needs key, path and checkCommand (offending entry: ${JSON.stringify(project)})`);
    }
  });

  return { ...config, projects: config.projects.map((project) => ({ ...project, path: path.resolve(expandHome(project.path)) })) };

};

export const writeRunnerConfig = (config: IRunnerConfigFile, file: string = configFilePath()): void => {
  writePrivateFile(file, `${JSON.stringify(config, null, 2)}\n`);
};

// The server part, or the reason the runner cannot start
export const requireServer = (config: IRunnerConfigFile): IRunnerServerConfig => {
  if (!config.server?.url || !config.server.credential) {
    throw new RunnerConfigError('This runner is not paired yet. Run: codingpowerup-runner connect --server <url> --code <code>');
  }
  return config.server;
};
