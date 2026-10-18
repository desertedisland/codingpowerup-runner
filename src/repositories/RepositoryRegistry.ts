// The projects on this machine, from runner.json, and what each checkout is on right now. The
// paths never leave the runner: the server hears the key, whether the checkout is present, its
// branch and commit.
import fs from 'fs';
import { IRunnerProjectConfig, IRunnerProjectPresence } from '@yellowmelon/factory-global-types';
import { tryRun } from '../platform/platform';

const git = (repoPath: string, args: string[]): Promise<string | undefined> => tryRun('git', ['-C', repoPath, ...args]);

export const describeProject = async (project: IRunnerProjectConfig): Promise<IRunnerProjectPresence> => {

  if (!fs.existsSync(project.path)) return { key: project.key, present: false, error: `Nothing at ${project.path}` };

  const branch = await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === undefined) return { key: project.key, present: false, error: `${project.path} is not a git checkout` };

  const commit = await git(project.path, ['rev-parse', '--short', 'HEAD']);
  return { key: project.key, present: true, branch, commit };

};

export const describeProjects = (projects: IRunnerProjectConfig[]): Promise<IRunnerProjectPresence[]> => Promise.all(projects.map(describeProject));
