// Git operations on a product's own checkout. A session works directly in the repo under
// PROJECTS_ROOT (no worktrees yet): what is checked out there is what the owner sees. A release
// cuts its branch from main and later sessions check that branch out; the older branch question
// (new factory branch or stay) is still here for the sessions that predate releases.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AUTHORIZABLE_PUSH_TARGETS, IPreparedWorkspace, IProjectCheckout, IPushAnalysis, IRunnerProjectRef, TBranchChoice } from '@yellowmelon/factory-global-types';
import logger from '../../log/logger';
import { resolveProjectPath } from '../../repositories/projectConfig';

const execFileAsync = promisify(execFile);

// Branches the factory must never work on directly, because finishing a session pushes the
// session's branch. The project's own default branch is added to these per project.
const PROTECTED_BRANCHES = ['main', 'production'];

// The shapes are the protocol's (IPreparedWorkspace, IProjectCheckout); the old name stays for the callers
export type IWorkspace = IPreparedWorkspace;
export type { IProjectCheckout };

// Run git in a repo and return trimmed stdout; a non-zero exit throws with stderr in the message.
// Exported for the read-only history reader, which lives beside this file.
export const git = async (repoPath: string, args: string[]): Promise<string> => {

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
    return stdout.trim();
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed in ${repoPath}: ${err.stderr || err.message}`);
  }

};

// A short name for a session's new branch
export const workspaceNameFor = (sessionId: string): string => `factory-${sessionId.slice(-8)}`;

// Whether the factory may keep working on (and later push) this branch of this project
export const isProtectedBranch = (project: IRunnerProjectRef, branch: string): boolean =>
  branch === project.defaultBranch || PROTECTED_BRANCHES.includes(branch);

export const hasUncommittedChanges = async (workingPath: string): Promise<boolean> => {
  const status = await git(workingPath, ['status', '--porcelain']);
  return status.length > 0;
};

// Read the state of a project's checkout: current branch and whether the tree is dirty
export const inspectCheckout = async (project: IRunnerProjectRef): Promise<IProjectCheckout> => {

  const repoPath = resolveProjectPath(project);

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Project repo not found at ${repoPath}`);
  }

  const currentBranch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const shortSha = await headShortSha(repoPath);
  const dirty = await hasUncommittedChanges(repoPath);

  return {
    repoPath,
    currentBranch,
    headShortSha: shortSha,
    hasUncommittedChanges: dirty,
    // A detached HEAD reads as "HEAD" and has no branch to push, so it cannot be stayed on either
    canStay: currentBranch !== 'HEAD' && !isProtectedBranch(project, currentBranch),
  };

};

// An owner-chosen branch name must be a valid git branch name and not one the factory may never
// push. An existing branch is refused by `checkout -b` itself.
const assertUsableBranchName = async (project: IRunnerProjectRef, repoPath: string, branch: string): Promise<void> => {

  if (isProtectedBranch(project, branch)) {
    throw new Error(`${branch} is a branch the factory never works on directly. Pick another name.`);
  }

  const isValid = await git(repoPath, ['check-ref-format', '--branch', branch]).then(() => true).catch(() => false);
  if (!isValid) throw new Error(`"${branch}" is not a valid branch name.`);

};

// Put the checkout on the session's branch and return it with the repo as the working path.
// Throws with an owner-readable message when the choice is refused. A new branch is cut from the
// branch currently checked out, not the registry's default branch: the products' main lines lag
// far behind their version branches, and what is checked out is what the owner is working on.
// Nothing is pulled from the remote: the factory works from whatever the owner last pulled.
export const createWorkspace = async (
  project: IRunnerProjectRef,
  sessionId: string,
  choice: TBranchChoice,
  branchName?: string, // for a new branch; defaults to factory-<id>
): Promise<IWorkspace> => {

  const checkout = await inspectCheckout(project);
  const { repoPath } = checkout;
  let branch: string;

  if (choice === 'new') {

    // Uncommitted work belongs to the owner or another session; a checkout would carry it along
    if (checkout.hasUncommittedChanges) {
      throw new Error(`${project.name} has uncommitted changes on ${checkout.currentBranch}. Commit or stash them first.`);
    }

    branch = branchName?.trim() || workspaceNameFor(sessionId);
    await assertUsableBranchName(project, repoPath, branch);
    await git(repoPath, ['checkout', '-q', '-b', branch]);
    logger.info(`[ws-create] Checked out new branch ${branch} from ${checkout.currentBranch} in ${repoPath}`);

  } else {

    if (!checkout.canStay) {
      throw new Error(`${project.name} is on ${checkout.currentBranch}, which the factory never works on directly. Start a new branch instead.`);
    }

    branch = checkout.currentBranch;
    logger.info(`[ws-create] Staying on branch ${branch} in ${repoPath}`);

  }

  const baseCommit = await git(repoPath, ['rev-parse', 'HEAD']);
  return { branch, workingPath: repoPath, baseCommit };

};

// Cut a release branch from the project's main line. Only the ref is made: nothing is checked
// out, so the owner's checkout keeps its branch and its uncommitted work. Sessions on the
// release each get their own worktree (lib/git/Worktrees) and land their work on this ref. The
// base is always main (the deployable branch), never whatever happens to be checked out: a
// release is what goes back onto main. Git itself refuses a name that already exists.
export const createReleaseBranch = async (project: IRunnerProjectRef, branch: string): Promise<IWorkspace> => {

  const repoPath = resolveProjectPath(project);
  if (!fs.existsSync(repoPath)) throw new Error(`Project repo not found at ${repoPath}`);

  await git(repoPath, ['branch', branch, project.defaultBranch]);
  const baseCommit = await git(repoPath, ['rev-parse', branch]);
  logger.info(`[ws-release] Cut release branch ${branch} from ${project.defaultBranch} at ${baseCommit.slice(0, 8)} in ${repoPath}`);

  return { branch, workingPath: repoPath, baseCommit };

};

// Commit everything outstanding; used when the agent finished without committing
export const commitAll = async (workingPath: string, message: string): Promise<void> => {
  await git(workingPath, ['add', '-A']);
  await git(workingPath, ['commit', '-q', '-m', message]);
};

// Short hash and subject of the current commit
export const headCommit = async (workingPath: string): Promise<string> => {
  return git(workingPath, ['log', '-1', '--format=%h %s']);
};

// Just the short hash of HEAD, for stamping a test run with what it ran against
export const headShortSha = async (workingPath: string): Promise<string> => git(workingPath, ['rev-parse', '--short', 'HEAD']);

// Files changed since the session opened. `base` is the session's baseCommit, so a session that
// stayed on an existing branch reports only its own work, not the whole branch.
export const changedFilesSummary = async (workingPath: string, base: string): Promise<string> => {
  return git(workingPath, ['diff', '--stat', base, 'HEAD']);
};

export const pushBranch = async (workingPath: string, branch: string): Promise<void> => {
  await git(workingPath, ['push', '-u', 'origin', branch]);
  logger.info(`[ws-push] Pushed ${branch}`);
};

// AUTHORIZABLE_PUSH_TARGETS (the shared types) says which branches the owner may authorize a
// push to: a project's main line, never production, and nothing below ever passes --force.
export { AUTHORIZABLE_PUSH_TARGETS };

const countCommits = async (workingPath: string, range: string): Promise<number> => {
  const out = await git(workingPath, ['rev-list', '--count', range]).catch(() => '0');
  return parseInt(out, 10) || 0;
};

// Read-only: fetches the two branches and reports how they stand, without touching the working
// tree or the index. `git merge-tree` computes the merge result in-memory, so a conflict shows up
// here without ever running (and having to abort) a real merge in a checkout a session is using.
export const analyzeBranchPush = async (
  workingPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<IPushAnalysis> => {

  // Fetched separately: the source branch may not exist on origin yet (a local-only session
  // branch), and a combined fetch would fail outright and leave the target's tracking ref stale
  await git(workingPath, ['fetch', 'origin', targetBranch]).catch((err) => {
    logger.warn(`[ws-push-analyze] Fetching ${targetBranch} failed: ${err.message}`);
  });
  await git(workingPath, ['fetch', 'origin', sourceBranch]).catch((err) => {
    logger.warn(`[ws-push-analyze] Fetching ${sourceBranch} failed: ${err.message}`);
  });

  const hasUncommitted = await hasUncommittedChanges(workingPath);
  const targetBehindRemote = await countCommits(workingPath, `${targetBranch}..origin/${targetBranch}`);
  const sourceAheadOfTarget = await countCommits(workingPath, `${targetBranch}..${sourceBranch}`);

  const likelyConflict = await git(workingPath, ['merge-tree', '--write-tree', targetBranch, sourceBranch])
    .then(() => false)
    .catch(() => true);

  return {
    targetBranch, sourceBranch, hasUncommittedChanges: hasUncommitted, targetBehindRemote, sourceAheadOfTarget, likelyConflict,
  };

};

// Merge the source branch into the target and push it. Restricted at the code level to
// AUTHORIZABLE_PUSH_TARGETS - production and force-pushing are not reachable through this
// function at all, regardless of what called it. The checkout ends back on sourceBranch, since
// that is the branch the session owns.
export const mergeAndPush = async (workingPath: string, sourceBranch: string, targetBranch: string): Promise<void> => {

  if (!AUTHORIZABLE_PUSH_TARGETS.includes(targetBranch)) {
    throw new Error(`${targetBranch} is not a branch the factory may push to.`);
  }

  await git(workingPath, ['fetch', 'origin', targetBranch]);
  await git(workingPath, ['checkout', '-q', targetBranch]);

  try {
    await git(workingPath, ['merge', '-q', `origin/${targetBranch}`]);
    await git(workingPath, ['merge', '-q', '--no-edit', sourceBranch]);
    await git(workingPath, ['push', 'origin', targetBranch]);
    logger.info(`[ws-push] Merged ${sourceBranch} into ${targetBranch} and pushed`);
  } finally {
    await git(workingPath, ['checkout', '-q', sourceBranch]).catch((err) => {
      logger.error(`[ws-push] Could not return the checkout to ${sourceBranch}: ${err.message}`);
    });
  }

};
