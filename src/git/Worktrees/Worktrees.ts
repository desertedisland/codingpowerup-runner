// A git worktree per session, so several sessions work on one product at once and the owner's
// own checkout is never switched. An Explore session gets a sandbox branch; a branch session
// gets its own branch off the release, and lands it on the release branch when its work is
// green (a merge in its own worktree, then the release ref moves forward). Dependencies are
// linked in from the product checkout rather than installed again, and so are its git-ignored
// .env files, without which the product's rebuild refuses to run.
import fs from 'fs';
import path from 'path';
import { IRunnerProjectRef } from '@yellowmelon/factory-global-types';
import logger from '../../log/logger';
import { resolveProjectPath } from '../../repositories/projectConfig';
import { worktreeRoot, worktreeRootProblem } from '../../config/paths';
import { git, IWorkspace } from '../Workspace/Workspace';

// How deep to look for node_modules folders to link: the repo root and its direct packages
// (zen-api, zen-client, ...) cover every monorepo the factory works on
const DEPENDENCY_LINK_DEPTH = 2;

// A merge that git could not complete on its own
export class MergeConflictError extends Error {
  constructor(public readonly output: string) {
    super('The merge has conflicts');
  }
}

export const worktreePathFor = (project: IRunnerProjectRef, sessionId: string): string => path.join(worktreeRoot(), project.key, sessionId);

// A sandbox's own branch name: system-named, never shown to the owner as a branch
export const sandboxBranchNameFor = (sessionId: string): string => `sandbox-${sessionId.slice(-8)}`;

// A branch session's own branch: off the release, named after it, landed back on it when green
export const sessionBranchNameFor = (releaseName: string, sessionId: string): string => `${releaseName}--${sessionId.slice(-8)}`;

// Every node_modules under `repoPath` (to a small depth), as paths relative to it
const findDependencyFolders = (repoPath: string, depth = DEPENDENCY_LINK_DEPTH, relative = ''): string[] => {
  const here = path.join(repoPath, relative);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return [];
    const relativePath = path.join(relative, entry.name);
    if (entry.name === 'node_modules') return [relativePath];
    return depth > 1 ? findDependencyFolders(repoPath, depth - 1, relativePath) : [];
  });
};

// Link each node_modules of the checkout into the worktree at the same place. A junction on
// Windows, a symlink elsewhere; a package already present in the worktree is left alone.
export const linkDependencies = (repoPath: string, worktreePath: string): string[] => {
  const linked: string[] = [];
  findDependencyFolders(repoPath).forEach((relativePath) => {
    const target = path.join(repoPath, relativePath);
    const link = path.join(worktreePath, relativePath);
    if (fs.existsSync(link)) return;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked.push(relativePath);
  });
  return linked;
};

// An environment file: .env, .env.local, .env.staging and so on
const ENV_FILE_PATTERN = /^\.env(\.[\w-]+)?$/;

// The checkout's .env files at the root and one level down (zen-api/.env, zen-client/.env, ...),
// relative to it
const findEnvFiles = (repoPath: string): string[] => {
  const folders = [''];
  try {
    fs.readdirSync(repoPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .forEach((entry) => folders.push(entry.name));
  } catch { return []; }
  return folders.flatMap((folder) => {
    try {
      return fs.readdirSync(path.join(repoPath, folder), { withFileTypes: true })
        .filter((entry) => entry.isFile() && ENV_FILE_PATTERN.test(entry.name))
        .map((entry) => path.join(folder, entry.name));
    } catch { return []; }
  });
};

// Link the checkout's git-ignored .env files into the worktree at the same place, so a rebuild
// from the worktree finds its API's config (rebuild.sh stops without it). Only files git ignores
// in the checkout are linked, so a link can never be committed; one the worktree already has
// (a tracked .env.example) is left alone. The values stay in the one file on the droplet.
export const linkEnvFiles = async (repoPath: string, worktreePath: string): Promise<string[]> => {
  const linked: string[] = [];
  for (const relativePath of findEnvFiles(repoPath)) {
    const link = path.join(worktreePath, relativePath);
    if (fs.existsSync(link) || !fs.existsSync(path.dirname(link))) continue;
    const isIgnored = await git(repoPath, ['check-ignore', '-q', relativePath]).then(() => true).catch(() => false);
    if (!isIgnored) continue;
    fs.symlinkSync(path.join(repoPath, relativePath), link, 'file');
    linked.push(relativePath);
  }
  return linked;
};

// Everything a worktree borrows from the checkout: its dependencies and its .env files.
// Idempotent, so a worktree made before a link was added gets it on its next build.
export const linkCheckoutFiles = async (project: IRunnerProjectRef, worktreePath: string): Promise<void> => {
  const repoPath = resolveProjectPath(project);
  linkDependencies(repoPath, worktreePath);
  await linkEnvFiles(repoPath, worktreePath);
};

// Make a session's worktree on a new branch cut from `base`. Nothing in the product checkout
// changes: not its branch, not its working tree.
export const createSessionWorktree = async (project: IRunnerProjectRef, sessionId: string, branch: string, base: string): Promise<IWorkspace> => {

  const rootProblem = worktreeRootProblem();
  if (rootProblem) throw new Error(rootProblem);

  const repoPath = resolveProjectPath(project);
  if (!fs.existsSync(repoPath)) throw new Error(`Project repo not found at ${repoPath}`);

  const workingPath = worktreePathFor(project, sessionId);
  fs.mkdirSync(path.dirname(workingPath), { recursive: true });

  await git(repoPath, ['worktree', 'add', '-q', '-b', branch, workingPath, base]);
  const baseCommit = await git(workingPath, ['rev-parse', 'HEAD']);
  const linked = linkDependencies(repoPath, workingPath);
  const envFiles = await linkEnvFiles(repoPath, workingPath);
  logger.info(`[worktree-create] ${project.key}: ${branch} from ${base} at ${baseCommit.slice(0, 8)} in ${workingPath}, ${linked.length} node_modules and ${envFiles.length} .env file(s) linked`);

  return { branch, workingPath, baseCommit };

};

// Take a session's worktree away. Uncommitted work is committed first so nothing is lost on
// its branch; the branch itself stays unless asked otherwise (a sandbox is disposable).
export const removeSessionWorktree = async (project: IRunnerProjectRef, workingPath: string, options: { deleteBranch?: string } = {}): Promise<void> => {

  const repoPath = resolveProjectPath(project);

  if (fs.existsSync(workingPath)) {
    const dirty = await git(workingPath, ['status', '--porcelain']).catch(() => '');
    if (dirty) {
      await git(workingPath, ['add', '-A']);
      await git(workingPath, ['commit', '-q', '-m', 'factory: work in progress when the session closed']).catch((err) => {
        logger.warn(`[worktree-remove] Could not commit leftovers in ${workingPath}: ${err.message}`);
      });
    }
    await git(repoPath, ['worktree', 'remove', '--force', workingPath]);
  }

  await git(repoPath, ['worktree', 'prune']).catch(() => undefined);

  if (options.deleteBranch) {
    await git(repoPath, ['branch', '-D', options.deleteBranch]).catch((err) => {
      logger.warn(`[worktree-remove] Could not delete ${options.deleteBranch}: ${err.message}`);
    });
  }

  logger.info(`[worktree-remove] ${project.key}: removed ${workingPath}${options.deleteBranch ? ` and branch ${options.deleteBranch}` : ''}`);

};

// The worktree that has `branch` checked out, if any (the owner's own checkout may be on it)
const worktreeHolding = async (repoPath: string, branch: string): Promise<string | undefined> => {
  const listing = await git(repoPath, ['worktree', 'list', '--porcelain']);
  let current: string | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return undefined;
};

// Land a session's work on the release branch. First the release is merged into the session's
// branch, in the session's own worktree, so the result is checked there; a conflict throws
// MergeConflictError with the merge left in progress for the agent to resolve. Then the release
// ref moves forward: fast-forwarded in whatever worktree has it checked out, else moved directly.
export const landOnRelease = async (project: IRunnerProjectRef, workingPath: string, releaseName: string): Promise<string> => {

  const repoPath = resolveProjectPath(project);

  try {
    await git(workingPath, ['merge', '-q', '--no-edit', releaseName]);
  } catch (err) {
    const status = await git(workingPath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    logger.warn(`[worktree-land] ${project.key}: merging ${releaseName} into the session branch conflicted: ${status || err.message}`);
    throw new MergeConflictError(status || err.message);
  }

  const head = await git(workingPath, ['rev-parse', 'HEAD']);
  const holder = await worktreeHolding(repoPath, releaseName);

  if (holder) {
    await git(holder, ['merge', '-q', '--ff-only', head]);
  } else {
    await git(repoPath, ['update-ref', `refs/heads/${releaseName}`, head]);
  }

  logger.info(`[worktree-land] ${project.key}: ${releaseName} now at ${head.slice(0, 8)}${holder ? ` (fast-forwarded in ${holder})` : ''}`);
  return head;

};

// Rename the branch a worktree has checked out: a sandbox made real takes a session-branch name
export const renameWorktreeBranch = async (workingPath: string, newName: string): Promise<void> => {
  await git(workingPath, ['branch', '-m', newName]);
  logger.info(`[worktree-rename] ${workingPath} now on ${newName}`);
};

// Push the release branch from a session's worktree (the branch need not be checked out there)
export const pushRelease = async (workingPath: string, releaseName: string): Promise<void> => {
  await git(workingPath, ['push', '-u', 'origin', releaseName]);
  logger.info(`[worktree-push] Pushed ${releaseName}`);
};

// The preview's "Branch": the open release built on its own, in one worktree per project that
// every release reuses. It is detached, so it never holds the release branch and landOnRelease
// moves the ref freely; each build forces it to the release's current commit, because nothing
// but build output is ever written there.
export const releasePreviewPathFor = (project: IRunnerProjectRef): string => path.join(worktreeRoot(), project.key, 'release-preview');

export const prepareReleasePreview = async (project: IRunnerProjectRef, releaseName: string): Promise<string> => {

  const rootProblem = worktreeRootProblem();
  if (rootProblem) throw new Error(rootProblem);

  const repoPath = resolveProjectPath(project);
  const workingPath = releasePreviewPathFor(project);

  if (fs.existsSync(workingPath)) {
    await git(workingPath, ['checkout', '-q', '--force', '--detach', releaseName]);
  } else {
    fs.mkdirSync(path.dirname(workingPath), { recursive: true });
    await git(repoPath, ['worktree', 'add', '-q', '--detach', workingPath, releaseName]);
  }

  linkDependencies(repoPath, workingPath);
  await linkEnvFiles(repoPath, workingPath);
  logger.info(`[worktree-release-preview] ${project.key}: ${releaseName} checked out in ${workingPath}`);
  return workingPath;

};
