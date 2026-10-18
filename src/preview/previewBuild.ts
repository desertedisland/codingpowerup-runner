// The runner's half of a preview build: get the working copy ready (the release's detached
// worktree brought to the release's commit; a worktree given the checkout's dependencies and
// .env files), then run the project's rebuild command through the build queue. What the site
// now shows is the server's business (lib/preview/PreviewSite writes the record from the
// result); this only builds and reports.
import { ICommandOutcome, IRunnerProjectRef, IStartPreviewPayload, IStartPreviewResult, TRunnerJobProgress } from '@yellowmelon/factory-global-types';
import logger from '../log/logger';
import { projectRebuildCommand, resolveProjectPath } from '../repositories/projectConfig';
import { enqueueHeavyWork } from '../queue/HeavyWorkQueue';
import { runCommand } from '../process/runCommand/runCommand';
import { headShortSha } from '../git/Workspace/Workspace';
import { linkCheckoutFiles, prepareReleasePreview, releasePreviewPathFor } from '../git/Worktrees/Worktrees';

const REBUILD_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 1500;

const failedBefore = (command: string, output: string): ICommandOutcome => ({ command, exitCode: 1, output, durationMs: 0, timedOut: false });

// Where the build runs from, for each kind of source
const workingPathFor = (project: IRunnerProjectRef, payload: IStartPreviewPayload): string => {
  switch (payload.source.kind) {
    case 'session': return payload.source.workingPath;
    case 'release': return releasePreviewPathFor(project);
    default: return resolveProjectPath(project);
  }
};

export const buildPreview = async (payload: IStartPreviewPayload, onProgress?: (progress: TRunnerJobProgress) => void): Promise<IStartPreviewResult> => {

  const { project, source, label } = payload;
  const command = projectRebuildCommand(project);
  if (!command) throw new Error(`${project.name} has no preview site to rebuild here.`);

  const workingPath = workingPathFor(project, payload);
  const queueLabel = `${project.key} rebuild (${source.kind === 'checkout' ? 'checkout' : source.kind === 'release' ? source.releaseName : source.branch || 'session'})`;
  let commit: string | undefined;

  // A release is brought up to date inside the queued job, so it never moves under a build
  // still running in it; the other sources are what they are, so their commit is known now
  if (source.kind !== 'release') {
    commit = await headShortSha(workingPath).catch(() => undefined);
    if (commit && onProgress) onProgress({ kind: 'commit', commit });
  }

  logger.info(`[preview-build] ${project.key}: rebuilding from ${source.kind} (${label}) in ${workingPath}`);

  const result = await enqueueHeavyWork(
    queueLabel,
    async () => {
      if (source.kind === 'release') {
        try {
          await prepareReleasePreview(project, source.releaseName);
        } catch (err) {
          return failedBefore(command, `Could not get ${label} ready to build: ${err.message}`);
        }
        commit = await headShortSha(workingPath).catch(() => undefined);
        if (commit && onProgress) onProgress({ kind: 'commit', commit });
      }
      // A worktree borrows the checkout's dependencies and .env files; one made before the
      // .env links existed gets them here
      if (source.kind !== 'checkout') {
        try {
          await linkCheckoutFiles(project, workingPath);
        } catch (err) {
          return failedBefore(command, `Could not link the checkout's files into ${label}: ${err.message}`);
        }
      }
      return runCommand(command, workingPath, { timeoutMs: REBUILD_TIMEOUT_MS });
    },
    (ahead) => { if (onProgress) onProgress({ kind: 'waiting', ahead }); },
  );

  const ok = result.exitCode === 0;
  if (ok) logger.info(`[preview-build] ${project.key}: built ${label} (${commit || 'unknown commit'})`);
  else logger.warn(`[preview-build] ${project.key}: rebuild from ${label} failed (exit ${result.exitCode})`);

  return { ok, workingPath, commit, outputTail: result.output.slice(-OUTPUT_TAIL_CHARS).trim() };

};
