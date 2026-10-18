// Read-only git reading for a project's History page: the commits on the checked-out branch
// over a period, which of them are merges or carry a tag, and where HEAD stands. Nothing here
// changes the checkout; it only runs `git log`, `rev-parse` and `describe`.
import { IGitCommit, IGitHistory, IRunnerProjectRef } from '@yellowmelon/factory-global-types';
import logger from '../../log/logger';
import { git, inspectCheckout } from '../Workspace/Workspace';

const FIELD_SEPARATOR = '\x1f';
const MAX_COMMITS = 300;

// IGitCommit and IGitHistory are the protocol's shapes (the project_history job's result)
export type { IGitCommit, IGitHistory };

// Tag names out of git's decoration list, e.g. "HEAD -> main, tag: v1.2.0, origin/main"
export const parseTags = (decorations: string): string[] =>
  decorations.split(',').map((part) => part.trim()).filter((part) => part.startsWith('tag: ')).map((part) => part.slice(5));

// One `git log` line in the format below into a commit
export const parseCommitLine = (line: string): IGitCommit | undefined => {
  const [sha, shortSha, parentList, authoredAt, subject, decorations] = line.split(FIELD_SEPARATOR);
  if (!sha || !shortSha || !authoredAt) return undefined;
  const parents = parentList ? parentList.split(' ').filter(Boolean) : [];
  return { sha, shortSha, parents, authoredAt, subject: subject || '', tags: parseTags(decorations || ''), isMerge: parents.length > 1 };
};

// The commits reachable from HEAD since `since` (all of them, capped, when absent)
export const readGitHistory = async (project: IRunnerProjectRef, since?: Date): Promise<IGitHistory> => {

  const checkout = await inspectCheckout(project);
  const { repoPath } = checkout;

  const logArguments = [
    'log', `--max-count=${MAX_COMMITS}`, '--date=iso-strict',
    `--format=%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%D`,
  ];
  if (since) logArguments.push(`--since=${since.toISOString()}`);

  const [log, headShortSha, latestTag] = await Promise.all([
    git(repoPath, logArguments),
    git(repoPath, ['rev-parse', '--short', 'HEAD']),
    // No tag reachable from HEAD is an ordinary state, not an error
    git(repoPath, ['describe', '--tags', '--abbrev=0']).catch(() => undefined),
  ]);

  const commits = log.split('\n').map(parseCommitLine).filter((commit): commit is IGitCommit => Boolean(commit));
  logger.debug(`[git-history] ${project.key}: ${commits.length} commit(s) on ${checkout.currentBranch}${since ? ` since ${since.toISOString()}` : ''}`);

  return { currentBranch: checkout.currentBranch, headShortSha, latestTag: latestTag || undefined, commits };

};
