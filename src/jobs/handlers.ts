// What the runner does for each job kind, by calling the moved modules: git in the checkouts and
// worktrees, the agent, the checks through the build queue, the preview build. The same table the
// control plane's LocalRunner had in step 2; the control plane now only ever sends jobs.
import os from 'os';
import {
  AUTHORIZABLE_PUSH_TARGETS, ERunnerErrorCode, ERunnerJobKind, IAgentTurnPayload, IAgentTurnResult, IRunnerError, IRunnerProjectInfo, IRunnerProjectRef,
  TPrepareWorkspacePayload, TRunnerJobPayload, TRunnerJobProgress, TRunnerJobResult,
} from '@yellowmelon/factory-global-types';
import { interrupt, runAgentTurn } from '../agents/AgentRunner/AgentRunner';
import { enqueueHeavyWork } from '../queue/HeavyWorkQueue';
import { runCommand } from '../process/runCommand/runCommand';
import { startDetached } from '../process/startDetached/startDetached';
import { localProjectConfig, projectCheckCommand, projectRebuildCommand, projectRebuildsTheFactory, ProjectNotConfiguredError } from '../repositories/projectConfig';
import {
  analyzeBranchPush, changedFilesSummary, commitAll, createReleaseBranch, createWorkspace, hasUncommittedChanges, headCommit, headShortSha, inspectCheckout,
  mergeAndPush, pushBranch,
} from '../git/Workspace/Workspace';
import { createSessionWorktree, landOnRelease, MergeConflictError, removeSessionWorktree, renameWorktreeBranch } from '../git/Worktrees/Worktrees';
import { readGitHistory } from '../git/ProjectHistory/ProjectHistory';
import { sandboxStats } from '../git/sandboxStats/sandboxStats';
import { buildPreview } from '../preview/previewBuild';
import { projectCanServe, ServedPreviews } from '../preview/servePreview';
import { canBuildFromCallback, handlersFromCallback, TCallbackHandler } from './callbacks';
import { fetchSessionAttachments, IAttachmentSource } from '../attachments/attachments';

// A failure with the typed reason the server acts on
export class JobError extends Error {
  constructor(public readonly code: ERunnerErrorCode, message: string, public readonly detail?: string) {
    super(message);
    this.name = 'JobError';
  }
  toRunnerError(): IRunnerError { return { code: this.code, message: this.message, detail: this.detail }; }
}

export interface IJobContext {
  onProgress: (progress: TRunnerJobProgress) => void;
  onOperation: (operation: { name: string; file?: string; input?: Record<string, unknown> }) => void;
  onCallback: TCallbackHandler;
  attachments: IAttachmentSource;
  served: ServedPreviews; // the applications this runner is serving as previews
}

type THandler<K extends ERunnerJobKind> = (payload: TRunnerJobPayload<K>, context: IJobContext) => Promise<TRunnerJobResult<K>>;

const refused = (message: string): never => { throw new JobError(ERunnerErrorCode.WORKSPACE_REFUSED, message); };

// Everything the server may want to know about a project here, in one read; a missing config or
// checkout is an answer, not an error
const inspectProject = async (project: IRunnerProjectRef): Promise<IRunnerProjectInfo> => {

  const entry = localProjectConfig(project);
  if (!entry) return { configured: false, canRebuildPreview: false, rebuildsTheFactory: false };

  const info: IRunnerProjectInfo = {
    configured: true,
    checkCommand: entry.checkCommand,
    rebuildCommand: entry.rebuildCommand,
    canRebuildPreview: !!entry.rebuildCommand && !entry.rebuildsTheFactory,
    canServePreview: !!entry.startCommand,
    rebuildsTheFactory: !!entry.rebuildsTheFactory,
  };

  try {
    info.checkout = await inspectCheckout(project);
  } catch (err) {
    info.checkoutError = (err as Error).message;
  }

  return info;

};

const prepareWorkspace = async (payload: TPrepareWorkspacePayload) => {
  const { project } = payload;
  switch (payload.mode) {
    case 'worktree': return createSessionWorktree(project, payload.sessionId, payload.branch, payload.base);
    case 'checkout': return createWorkspace(project, payload.sessionId, payload.choice, payload.branchName);
    case 'release_branch': return createReleaseBranch(project, payload.branch);
    default: return refused('Unknown workspace mode');
  }
};

// Missing Claude authentication is a sentence for the owner, not a stack trace
const isAuthFailure = (message: string): boolean => /not logged in|login|authenticat|OAuth|API key|credentials/i.test(message);

const agentTurn = async (payload: IAgentTurnPayload, context: IJobContext): Promise<IAgentTurnResult> => {

  const attachmentsDir = payload.sessionId && payload.attachmentNames?.length
    ? await fetchSessionAttachments(context.attachments, payload.sessionId, payload.attachmentNames)
    : undefined;
  const { planTools, exploreTools } = handlersFromCallback(context.onCallback, payload.turnKind);

  try {
    return await runAgentTurn({
      turnKind: payload.turnKind,
      key: payload.key,
      cwd: payload.workingPath,
      prompt: payload.prompt,
      systemPromptAppend: payload.systemPromptAppend,
      agentSessionId: payload.agentSessionId,
      model: payload.model,
      effort: payload.effort,
      rulesChangeApproved: payload.rulesChangeApproved,
      additionalDirectories: attachmentsDir ? [attachmentsDir] : [],
      onProgress: (progress) => context.onProgress({ kind: 'agent', progress }),
      onOperation: context.onOperation,
      planTools,
      exploreTools,
      canBuild: payload.turnKind === 'explore' ? canBuildFromCallback(context.onCallback) : undefined,
    });
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (isAuthFailure(message)) throw new JobError(ERunnerErrorCode.AGENT_AUTH_REQUIRED, 'Claude Code is not signed in on the runner. Run `claude login` there, or set CLAUDE_CODE_OAUTH_TOKEN for the runner, and try again.', message);
    throw err;
  }

};

export const handlers: { [K in ERunnerJobKind]: THandler<K> } = {

  [ERunnerJobKind.INSPECT_CHECKOUT]: ({ project }) => inspectProject(project),

  [ERunnerJobKind.PREPARE_WORKSPACE]: async (payload) => {
    try {
      return await prepareWorkspace(payload);
    } catch (err) {
      if (err instanceof JobError) throw err;
      if (err instanceof ProjectNotConfiguredError) throw new JobError(ERunnerErrorCode.PROJECT_NOT_CONFIGURED, err.message);
      throw new JobError(ERunnerErrorCode.WORKSPACE_REFUSED, (err as Error).message);
    }
  },

  [ERunnerJobKind.AGENT_TURN]: agentTurn,

  [ERunnerJobKind.INTERRUPT_TURN]: async ({ key }) => ({ interrupted: await interrupt(key) }),

  [ERunnerJobKind.RUN_CHECK]: async ({ project, workingPath, label }, context) => {
    const command = projectCheckCommand(project);
    if (!command) throw new JobError(ERunnerErrorCode.PROJECT_NOT_CONFIGURED, `Project ${project.key} has no check command on this machine`);
    return enqueueHeavyWork(label, () => runCommand(command, workingPath), (ahead) => context.onProgress({ kind: 'waiting', ahead }));
  },

  [ERunnerJobKind.GIT_COMMIT]: async ({ workingPath, message }) => {
    if (!(await hasUncommittedChanges(workingPath))) return { committed: false, commit: await headCommit(workingPath) };
    await commitAll(workingPath, message);
    return { committed: true, commit: await headCommit(workingPath) };
  },

  [ERunnerJobKind.INSPECT_WORKSPACE]: async ({ workingPath, base }) => ({
    headCommit: await headCommit(workingPath),
    headShortSha: await headShortSha(workingPath),
    hasUncommittedChanges: await hasUncommittedChanges(workingPath),
    changedFilesSummary: base ? await changedFilesSummary(workingPath, base) : undefined,
  }),

  [ERunnerJobKind.SANDBOX_STATS]: ({ workingPath, base }) => sandboxStats(workingPath, base),

  [ERunnerJobKind.LAND_ON_RELEASE]: async ({ project, workingPath, releaseName }) => {
    try {
      return { head: await landOnRelease(project, workingPath, releaseName) };
    } catch (err) {
      if (err instanceof MergeConflictError) throw new JobError(ERunnerErrorCode.MERGE_CONFLICT, err.message, err.output);
      throw err;
    }
  },

  [ERunnerJobKind.PUSH]: async ({ workingPath, branch }) => { await pushBranch(workingPath, branch); return { ok: true as const }; },

  [ERunnerJobKind.ANALYZE_PUSH]: ({ workingPath, sourceBranch, targetBranch }) => analyzeBranchPush(workingPath, sourceBranch, targetBranch),

  // Restricted on the runner's side as well as the server's: production and --force are not
  // reachable through this path whatever asked for it
  [ERunnerJobKind.MERGE_AND_PUSH]: async ({ workingPath, sourceBranch, targetBranch }) => {
    if (!AUTHORIZABLE_PUSH_TARGETS.includes(targetBranch)) throw new JobError(ERunnerErrorCode.PERMISSION_DENIED, `${targetBranch} is not a branch the factory may push to.`);
    await mergeAndPush(workingPath, sourceBranch, targetBranch);
    return { ok: true as const };
  },

  [ERunnerJobKind.RENAME_BRANCH]: async ({ workingPath, newName }) => { await renameWorktreeBranch(workingPath, newName); return { ok: true as const }; },

  [ERunnerJobKind.CLEANUP_WORKSPACE]: async ({ project, workingPath, deleteBranch }) => {
    await removeSessionWorktree(project, workingPath, deleteBranch ? { deleteBranch } : {});
    return { ok: true as const };
  },

  [ERunnerJobKind.PROJECT_HISTORY]: ({ project, since }) => readGitHistory(project, since ? new Date(since) : undefined),

  [ERunnerJobKind.START_PREVIEW]: async (payload, context) => {
    if (payload.strategy === 'serve') {
      if (!projectCanServe(payload.project)) throw new JobError(ERunnerErrorCode.NO_PREVIEW_HERE, `${payload.project.name} has no start command on this runner, so it cannot be served.`);
      try {
        const served = await context.served.start(payload, (text) => context.onProgress({ kind: 'note', text }));
        return { ok: true, workingPath: served.workingPath, commit: served.commit, outputTail: served.outputTail, localUrl: served.localUrl, reachableUrl: served.reachableUrl, ports: served.ports };
      } catch (err) {
        // A start that failed is an answer the owner reads, not a job failure: the record shows the output
        return { ok: false, workingPath: '', outputTail: (err as Error).message };
      }
    }
    if (!projectRebuildCommand(payload.project) || projectRebuildsTheFactory(payload.project)) {
      throw new JobError(ERunnerErrorCode.NO_PREVIEW_HERE, `${payload.project.name} has no preview site to rebuild here.`);
    }
    return buildPreview(payload, context.onProgress);
  },

  // A served preview's application is stopped; a rebuilt site keeps showing its build
  [ERunnerJobKind.STOP_PREVIEW]: async ({ previewId }, context) => {
    await context.served.stop(previewId, 'stopped by the factory', false);
    return { ok: true as const };
  },

  [ERunnerJobKind.START_APPLICATION]: async ({ project, workingPath, label, previewId }, context) => {
    if (!projectCanServe(project)) throw new JobError(ERunnerErrorCode.NO_PREVIEW_HERE, `${project.name} has no start command on this runner.`);
    const started = await context.served.start({ project, source: { kind: 'session', workingPath }, label, strategy: 'serve', previewId }, (text) => context.onProgress({ kind: 'note', text }));
    return { processId: started.processId, ports: started.ports, localUrl: started.localUrl, reachableUrl: started.reachableUrl, outputTail: started.outputTail };
  },

  [ERunnerJobKind.STOP_APPLICATION]: async ({ processId }, context) => {
    const preview = context.served.all().find((candidate) => candidate.processId === processId);
    if (preview) await context.served.stop(preview.previewId, 'stopped by the factory', false);
    return { ok: true as const };
  },

  [ERunnerJobKind.RESTART_FACTORY]: async ({ project, workingPath, logFile }) => {
    const command = projectRebuildCommand(project);
    if (!command || !projectRebuildsTheFactory(project)) throw new JobError(ERunnerErrorCode.NO_PREVIEW_HERE, `${project.name} is not the factory on this machine.`);
    if (os.platform() === 'win32') throw new JobError(ERunnerErrorCode.NOT_SUPPORTED, 'Restarting the factory needs a POSIX shell.');
    startDetached(command, workingPath, logFile);
    return { command };
  },

};

// Owner-readable, as the wrapped modules' errors always were, with the typed code where one fits
export const toRunnerError = (err: unknown): IRunnerError => {
  if (err instanceof JobError) return err.toRunnerError();
  if (err instanceof ProjectNotConfiguredError) return { code: ERunnerErrorCode.PROJECT_NOT_CONFIGURED, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (/repo not found at/.test(message)) return { code: ERunnerErrorCode.CHECKOUT_MISSING, message };
  return { code: ERunnerErrorCode.FAILED, message };
};
