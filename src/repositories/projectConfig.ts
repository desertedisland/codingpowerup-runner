// The projects on this machine as the moved modules ask for them: where a checkout is, and which
// commands check and rebuild it. Read from runner.json (RunnerConfig) once per path; reloadable
// so tests write their own file.
import { IRunnerProjectConfig, IRunnerProjectRef } from '@yellowmelon/factory-global-types';
import { readRunnerConfig } from '../config/RunnerConfig';
import { configFilePath } from '../platform/platform';

// A project the control plane knows but this machine has no checkout or commands for
export class ProjectNotConfiguredError extends Error {
  constructor(projectKey: string) {
    super(`Project ${projectKey} is not configured on this machine (no entry in the runner config)`);
    this.name = 'ProjectNotConfiguredError';
  }
}

let cached: { path: string; projects: IRunnerProjectConfig[] } | undefined;

const load = (): IRunnerProjectConfig[] => {
  const file = configFilePath();
  if (cached && cached.path === file) return cached.projects;
  cached = { path: file, projects: readRunnerConfig(file).projects };
  return cached.projects;
};

export const reloadProjectConfig = (): void => { cached = undefined; };

export const listLocalProjectConfigs = (): IRunnerProjectConfig[] => load();

export const localProjectConfig = (project: Pick<IRunnerProjectRef, 'key'>): IRunnerProjectConfig | undefined => load().find((entry) => entry.key === project.key);

export const isProjectConfiguredLocally = (project: Pick<IRunnerProjectRef, 'key'>): boolean => !!localProjectConfig(project);

export const resolveProjectPath = (project: Pick<IRunnerProjectRef, 'key'>): string => {
  const entry = localProjectConfig(project);
  if (!entry) throw new ProjectNotConfiguredError(project.key);
  return entry.path;
};

export const projectCheckCommand = (project: Pick<IRunnerProjectRef, 'key'>): string | undefined => localProjectConfig(project)?.checkCommand;
export const projectRebuildCommand = (project: Pick<IRunnerProjectRef, 'key'>): string | undefined => localProjectConfig(project)?.rebuildCommand;
export const projectRebuildsTheFactory = (project: Pick<IRunnerProjectRef, 'key'>): boolean => !!localProjectConfig(project)?.rebuildsTheFactory;
