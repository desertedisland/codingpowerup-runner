// Where the runner keeps what it makes: session worktrees and downloaded attachments. Both must
// sit outside every configured checkout, or a worktree would be tracked by its own repository
// and an attachment could be committed.
import path from 'path';
import { readRunnerConfig } from './RunnerConfig';
import { configDirectory, configFilePath, expandHome } from '../platform/platform';
import { listLocalProjectConfigs } from '../repositories/projectConfig';

const isInside = (parent: string, child: string): boolean => {
  const normalise = (value: string) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(normalise(parent), normalise(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// FACTORY_WORKTREE_ROOT, else runner.json's capacity.worktreeRoot, else ~/.codingpowerup/worktrees
export const worktreeRoot = (): string => {
  if (process.env.FACTORY_WORKTREE_ROOT) return path.resolve(expandHome(process.env.FACTORY_WORKTREE_ROOT));
  const configured = readRunnerConfig(configFilePath()).capacity?.worktreeRoot;
  return path.resolve(expandHome(configured || path.join(configDirectory(), 'worktrees')));
};

// Null when the root is safe, else the reason; checked before every worktree is made
export const worktreeRootProblem = (root: string = worktreeRoot()): string | null => {
  const insideRepo = listLocalProjectConfigs().find((project) => isInside(project.path, root));
  return insideRepo ? `The worktree root ${root} is inside the ${insideRepo.key} repo.` : null;
};

export const attachmentsRootPath = (): string => path.join(configDirectory(), 'attachments');

export const isInsidePath = isInside;
