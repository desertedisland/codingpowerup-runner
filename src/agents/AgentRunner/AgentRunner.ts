// Drives one turn of a Claude Agent SDK session. Each owner message or factory step becomes one
// query() call that resumes the same SDK session, so the agent keeps its context across turns
// that arrive minutes or days apart. The tool policy depends on the turn kind: gathering turns
// are read-only and end in a proposal; implementation turns may edit, run commands and commit,
// and end in a report. Only the runner (lib/runner/LocalRunner) calls this: the server asks for
// an agent_turn job and never touches the SDK itself (docs/runner/SPEC.md, step 2).
import os from 'os';
import path from 'path';
import { McpServerConfig, query, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  IAgentOperation, IAgentProgress, IAgentTurnResult, IExploreToolHandlers, IFactoryProposal, IFactoryReport, IPlanToolHandlers, IPushRequestCapture,
  ITaskCardCapture, ITestCaseCapture, ITestInvestigationAnalysis, ITestResultCapture, TAgentTurnKind,
} from '@yellowmelon/factory-global-types';
import logger from '../../log/logger';
import { buildAgentEnvironment } from './agentEnvironment';
import {
  buildFactoryToolServer, FACTORY_SERVER_NAME, FACTORY_TOOL_PREFIX,
  CLASSIFY_REQUEST_TOOL, DRAFT_ITEM_TOOL, PROPOSE_BREAKDOWN_TOOL, REPORT_SANDBOX_TOOL,
  REMOVE_PLAN_ITEM_TOOL, UPDATE_PLAN_TOOL, UPSERT_PLAN_ITEM_TOOL,
  REQUEST_PUSH_TOOL, SUBMIT_INVESTIGATION_TOOL, SUBMIT_PROPOSAL_TOOL, SUBMIT_REPORT_TOOL, SUBMIT_TASK_CARD_TOOL, SUBMIT_TEST_CASE_TOOL,
  SUBMIT_TEST_RESULT_TOOL,
} from './agentTools';
import { buildModeGuard, buildRuleFileGuard, buildUploadGuard, buildEnvFileGuard } from './agentHooks';

const PLAYWRIGHT_SERVER_NAME = 'playwright';
const PLAYWRIGHT_TOOL_PREFIX = `mcp__${PLAYWRIGHT_SERVER_NAME}__`;

// What one turn needs. The server builds the prompt and the role (systemPromptAppend) from its
// own prompts and sends them in the agent_turn job; the runner adds the tool policy for the turn
// kind, the hooks, the working directory and the agent's credentials. `key` is what an interrupt
// names: a session id, a test run id, investigation:<runId>.
export interface IAgentTurnSpec {
  turnKind: TAgentTurnKind;
  key: string;
  cwd: string;
  prompt: string;
  systemPromptAppend: string;
  agentSessionId?: string;
  model?: string;
  effort?: string;
  rulesChangeApproved?: boolean;
  additionalDirectories?: string[]; // the session's uploads, outside the repo
  onProgress?: (progress: IAgentProgress) => void;
  onOperation?: (operation: IAgentOperation) => void;
  planTools?: IPlanToolHandlers;       // a planning turn's live handlers
  exploreTools?: IExploreToolHandlers; // an Explore turn's live handlers
  canBuild?: () => boolean | Promise<boolean>; // an Explore turn: whether the editing tools are allowed right now
}

// Tools no factory turn may use, whatever its allowlist: the ones that hand work to a
// background subagent or a later wakeup, and the ones that leave the checkout. A turn must do
// its own work, in the foreground, in the directory it was given, so the factory's own tools
// (submit_proposal and the rest) are called from the turn that owns them. A turn that parked
// itself behind a background Agent and a ScheduleWakeup came back with every submit_proposal
// call "interrupted before a result was received", and the proposal was lost. These are not
// gated by allowedTools (they need no permission), hence disallowedTools.
const DISALLOWED_TOOLS = [
  'Agent', 'Task', 'ScheduleWakeup', 'Monitor', 'Workflow', 'TaskStop',
  'CronCreate', 'CronDelete', 'CronList',
  'EnterWorktree', 'ExitWorktree',
];

// Read-only exploration plus the proposal and push-request tools. Nothing here can change a
// file, and request_push itself only ever signals intent: the actual merge and push run in
// trusted flow code, never from inside an agent turn.
const GATHERING_TOOLS = ['Read', 'Glob', 'Grep', SUBMIT_PROPOSAL_TOOL, REQUEST_PUSH_TOOL];
const GATHERING_MAX_TURNS = 40;
const GATHERING_MAX_BUDGET_USD = 3;

// Editing plus the commands a developer needs, and nothing that leaves the checkout: no push,
// no checkout, no arbitrary shell. Anything not listed is denied under dontAsk.
const IMPLEMENTATION_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(dir *)',
  SUBMIT_REPORT_TOOL,
];
const IMPLEMENTATION_MAX_TURNS = 200;
const IMPLEMENTATION_MAX_BUDGET_USD = 15;

// Describing a test case: the same read-only tools as gathering, ending in submit_test_case
// instead of submit_proposal
const TEST_AUTHORING_TOOLS = ['Read', 'Glob', 'Grep', SUBMIT_TEST_CASE_TOOL];
const TEST_AUTHORING_MAX_TURNS = 40;
const TEST_AUTHORING_MAX_BUDGET_USD = 3;

// Describing a board card: the same shape as test authoring, ending in submit_task_card
const TASK_AUTHORING_TOOLS = ['Read', 'Glob', 'Grep', SUBMIT_TASK_CARD_TOOL];
const TASK_AUTHORING_MAX_TURNS = 40;
const TASK_AUTHORING_MAX_BUDGET_USD = 3;

// Planning: the PM agent reads the code and writes the plan through the three plan tools, which
// act on the plan at once (the sidecar is live). Longer-lived than the authoring turns, so a
// turn may read more.
const PLANNING_TOOLS = ['Read', 'Glob', 'Grep', UPDATE_PLAN_TOOL, UPSERT_PLAN_ITEM_TOOL, REMOVE_PLAN_ITEM_TOOL];
const PLANNING_MAX_TURNS = 60;
const PLANNING_MAX_BUDGET_USD = 4;

// Explore: the engineer's tools (as implementation, minus submit_report) plus the four Explore
// tools. The mode guard hook decides when the editing tools and shell may actually run: only in
// Build, once classify_request has sized the request S or M. The Explore tools act at once.
const EXPLORE_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(dir *)',
  CLASSIFY_REQUEST_TOOL, PROPOSE_BREAKDOWN_TOOL, REPORT_SANDBOX_TOOL, DRAFT_ITEM_TOOL,
];
const EXPLORE_MAX_TURNS = 200;
const EXPLORE_MAX_BUDGET_USD = 15;

// Running a test case: no file tools at all, just a real browser (Playwright's own MCP server,
// run out-of-process so a hung or crashed browser cannot take the agent turn down with it) plus
// submit_test_result. `mcp__playwright__*` covers every tool that server publishes, whatever it
// calls them, the same pattern Bash(npm *) uses for a whole family of commands.
const TESTING_TOOLS = [`${PLAYWRIGHT_TOOL_PREFIX}*`, SUBMIT_TEST_RESULT_TOOL];
const TESTING_MAX_TURNS = 60;
const TESTING_MAX_BUDGET_USD = 5;

// Investigating a failed run: read the code, the git history and the API's logs, nothing that
// writes, ending in submit_investigation and a plain-text reply
const INVESTIGATION_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(pm2 logs *)',
  SUBMIT_INVESTIGATION_TOOL,
];
const INVESTIGATION_MAX_TURNS = 40;
const INVESTIGATION_MAX_BUDGET_USD = 3;

// @playwright/mcp is a declared dependency (package.json), so npx resolves it locally rather than
// fetching anything over the network at run time. The browser is pinned: without --browser the
// server picks the `chrome` channel, Google Chrome at /opt/google/chrome, which is not on the
// droplet. `chromium` is Playwright's own build, the one the runbook (DEPLOYMENT.md) installs.
// The server writes console logs and page snapshots to its working directory, which is the
// product checkout, so they go to a temp folder instead of leaving the tree dirty.
const playwrightServerConfig = (): McpServerConfig => ({
  type: 'stdio',
  command: 'npx',
  args: [
    '@playwright/mcp', '--headless', '--isolated', '--browser', 'chromium',
    '--output-dir', path.join(os.tmpdir(), 'zenfactory-playwright'),
  ],
});

// Live queries by factory session id, so /stop can interrupt the right one, and the sessions
// whose current turn was interrupted so the result can say so
const activeQueries = new Map<string, Query>();
const interruptedSessions = new Set<string>();

// The text blocks of an assistant message, joined. Tool-only messages yield an empty string.
export const extractAssistantText = (message: SDKMessage): string => {

  if (message.type !== 'assistant') return '';

  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim();

};

// The tool_use blocks of an assistant message, for progress reporting
const extractToolUses = (message: SDKMessage): (IAgentOperation & { id?: string })[] => {

  if (message.type !== 'assistant') return [];

  return message.message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => {
      const toolUse = block as { id?: string; name: string; input?: { file_path?: string; command?: string } & Record<string, unknown> };
      return { id: toolUse.id, name: toolUse.name, file: toolUse.input?.file_path || toolUse.input?.command, input: toolUse.input };
    });

};

// The ids of the tool calls a user message answers with an error
const extractFailedToolResults = (message: SDKMessage): string[] => {

  if (message.type !== 'user' || !Array.isArray(message.message.content)) return [];

  return message.message.content
    .filter((block) => block.type === 'tool_result' && (block as { is_error?: boolean }).is_error)
    .map((block) => (block as { tool_use_id: string }).tool_use_id);

};

// Drives a query() stream to completion against the active-query map (so /stop can find it by
// key) and collects the text, resumed session id, cost and whether it was interrupted. Shared by
// every turn kind; what each one does with a tool call (proposal, report, test case...) is
// decided by the captures passed into buildFactoryToolServer, not by this loop.
const driveQuery = async (
  key: string,
  stream: Query,
  initialAgentSessionId: string | undefined,
  hasCaptured: () => boolean,
  onProgress?: (progress: IAgentProgress) => void,
  onOperation?: (operation: IAgentOperation) => void,
): Promise<{ text: string; agentSessionId: string; costUsd: number; interrupted: boolean; failedFactoryTool?: string }> => {

  let agentSessionId = initialAgentSessionId;
  let lastText = '';
  let costUsd = 0;
  let interrupted = false;
  let failedFactoryTool: string | undefined;
  const progress: IAgentProgress = { toolCalls: 0 };
  const factoryToolCalls = new Map<string, string>(); // tool_use id -> factory tool name

  activeQueries.set(key, stream);

  try {

    for await (const message of stream) {

      if (message.type === 'system' && message.subtype === 'init') {
        agentSessionId = message.session_id;
      }

      if (message.type === 'assistant') {

        const text = extractAssistantText(message);
        if (text) lastText = text;

        const toolUses = extractToolUses(message);
        if (toolUses.length > 0) {
          progress.toolCalls += toolUses.length;
          progress.lastTool = toolUses[toolUses.length - 1].name;
          progress.lastFile = toolUses[toolUses.length - 1].file;
          if (onProgress) onProgress({ ...progress });
          if (onOperation) toolUses.forEach((toolUse) => onOperation(toolUse));
        }

        toolUses
          .filter((toolUse) => toolUse.id && toolUse.name.startsWith(FACTORY_TOOL_PREFIX))
          .forEach((toolUse) => factoryToolCalls.set(toolUse.id as string, toolUse.name));

      }

      // A factory tool call that errored never reached its handler, so its capture is missing;
      // remember which, so the caller can ask the agent to call it again
      if (message.type === 'user') {
        extractFailedToolResults(message)
          .filter((toolUseId) => factoryToolCalls.has(toolUseId))
          .forEach((toolUseId) => {
            failedFactoryTool = factoryToolCalls.get(toolUseId);
            logger.warn(`[agent-turn] ${key}: the ${failedFactoryTool} call came back as an error; its result was not captured`);
          });
      }

      if (message.type === 'result') {

        agentSessionId = message.session_id;
        costUsd = message.total_cost_usd;

        if (message.subtype !== 'success') {
          logger.warn(`[agent-turn] Turn ended with ${message.subtype} for ${key}`);
          if (!lastText && !hasCaptured()) {
            throw new Error(`Agent turn failed: ${message.subtype}`);
          }
        }

      }

    }

  } finally {
    interrupted = interruptedSessions.delete(key);
    activeQueries.delete(key);
  }

  logger.info(`[agent-turn] ${key} turn done, ${progress.toolCalls} tool calls, cost $${costUsd.toFixed(4)}`);

  // Only an error that left nothing captured counts: a later call may have succeeded
  return { text: lastText, agentSessionId, costUsd, interrupted, failedFactoryTool: hasCaptured() ? undefined : failedFactoryTool };

};

// The tool policy of each turn kind: what the agent may do, how long it may run, and which
// hooks watch it. The role (system prompt) and the prompt come from the server.
interface ITurnPolicy {
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  permissionMode: 'dontAsk' | 'acceptEdits';
  resumes: boolean; // a testing turn starts fresh every time
  hooks?: (spec: IAgentTurnSpec) => Parameters<typeof query>[0]['options']['hooks'];
  extraMcpServers?: () => Record<string, McpServerConfig>;
}

const TURN_POLICIES: Record<TAgentTurnKind, ITurnPolicy> = {
  gathering: { allowedTools: GATHERING_TOOLS, maxTurns: GATHERING_MAX_TURNS, maxBudgetUsd: GATHERING_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: true },
  implementation: {
    allowedTools: IMPLEMENTATION_TOOLS, maxTurns: IMPLEMENTATION_MAX_TURNS, maxBudgetUsd: IMPLEMENTATION_MAX_BUDGET_USD, permissionMode: 'acceptEdits', resumes: true,
    hooks: (spec) => ({ PreToolUse: [buildRuleFileGuard(Boolean(spec.rulesChangeApproved)), buildUploadGuard(), buildEnvFileGuard()] }),
  },
  test_authoring: { allowedTools: TEST_AUTHORING_TOOLS, maxTurns: TEST_AUTHORING_MAX_TURNS, maxBudgetUsd: TEST_AUTHORING_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: true },
  task_authoring: { allowedTools: TASK_AUTHORING_TOOLS, maxTurns: TASK_AUTHORING_MAX_TURNS, maxBudgetUsd: TASK_AUTHORING_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: true },
  planning: { allowedTools: PLANNING_TOOLS, maxTurns: PLANNING_MAX_TURNS, maxBudgetUsd: PLANNING_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: true },
  explore: {
    allowedTools: EXPLORE_TOOLS, maxTurns: EXPLORE_MAX_TURNS, maxBudgetUsd: EXPLORE_MAX_BUDGET_USD, permissionMode: 'acceptEdits', resumes: true,
    hooks: (spec) => ({ PreToolUse: [buildModeGuard(spec.canBuild || (() => true)), buildRuleFileGuard(false), buildUploadGuard(), buildEnvFileGuard()] }),
  },
  testing: {
    allowedTools: TESTING_TOOLS, maxTurns: TESTING_MAX_TURNS, maxBudgetUsd: TESTING_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: false,
    extraMcpServers: () => ({ [PLAYWRIGHT_SERVER_NAME]: playwrightServerConfig() }),
  },
  investigation: { allowedTools: INVESTIGATION_TOOLS, maxTurns: INVESTIGATION_MAX_TURNS, maxBudgetUsd: INVESTIGATION_MAX_BUDGET_USD, permissionMode: 'dontAsk', resumes: true },
};

// Run one turn of any kind and collect what came back: the text, the resumed agent session, the
// cost, and whatever the agent handed over through the factory's tools
export const runAgentTurn = async (spec: IAgentTurnSpec): Promise<IAgentTurnResult> => {

  const policy = TURN_POLICIES[spec.turnKind];
  if (!policy) throw new Error(`Unknown turn kind ${spec.turnKind}`);
  if (!spec.cwd) throw new Error('This turn has no working directory.');

  let proposal: IFactoryProposal | undefined;
  let report: IFactoryReport | undefined;
  let pushRequest: IPushRequestCapture | undefined;
  let testCase: ITestCaseCapture | undefined;
  let testResult: ITestResultCapture | undefined;
  let investigation: ITestInvestigationAnalysis | undefined;
  let taskCard: ITaskCardCapture | undefined;
  let planChanged = false;
  let exploreChanged = false;

  // The plan tools write at once; the turn only remembers that something changed
  const livePlanTools: IPlanToolHandlers | undefined = spec.planTools && {
    updatePlan: async (update) => { planChanged = true; return spec.planTools.updatePlan(update); },
    upsertItem: async (item) => { planChanged = true; return spec.planTools.upsertItem(item); },
    removeItem: async (itemId) => { planChanged = true; return spec.planTools.removeItem(itemId); },
  };

  // The Explore tools write the session at once too; the turn only remembers that one was called
  const liveExploreTools: IExploreToolHandlers | undefined = spec.exploreTools && {
    classify: async (capture) => { exploreChanged = true; return spec.exploreTools.classify(capture); },
    proposeBreakdown: async (capture) => { exploreChanged = true; return spec.exploreTools.proposeBreakdown(capture); },
    reportSandbox: async (capture) => { exploreChanged = true; return spec.exploreTools.reportSandbox(capture); },
    draftItem: async (capture) => { exploreChanged = true; return spec.exploreTools.draftItem(capture); },
  };

  const resume = policy.resumes ? spec.agentSessionId : undefined;

  const stream = query({
    prompt: spec.prompt,
    options: {
      cwd: spec.cwd,
      // The session's uploaded files live outside the repo; the agent may read them there
      additionalDirectories: spec.additionalDirectories || [],
      resume,
      // Keep the Claude Code preset (tools, conventions) and add the factory role on top
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPromptAppend },
      // 'project' loads the repo's CLAUDE.md files, which is where the business rules live
      settingSources: ['project'],
      allowedTools: policy.allowedTools,
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: policy.permissionMode,
      hooks: policy.hooks ? policy.hooks(spec) : undefined,
      model: spec.model,
      effort: spec.effort as Parameters<typeof query>[0]['options']['effort'],
      mcpServers: {
        ...(policy.extraMcpServers ? policy.extraMcpServers() : {}),
        [FACTORY_SERVER_NAME]: buildFactoryToolServer({
          onProposal: (captured) => { proposal = captured; },
          onReport: (captured) => { report = captured; },
          onPushRequest: (captured) => { pushRequest = captured; },
          onTestCase: (captured) => { testCase = captured; },
          onTestResult: (captured) => { testResult = captured; },
          onInvestigation: (captured) => { investigation = captured; },
          onTaskCard: (captured) => { taskCard = captured; },
          planTools: livePlanTools,
          exploreTools: liveExploreTools,
        }),
      },
      maxTurns: policy.maxTurns,
      maxBudgetUsd: policy.maxBudgetUsd,
      env: buildAgentEnvironment(),
    },
  });

  const collected = await driveQuery(
    spec.key, stream, resume,
    () => Boolean(proposal || report || pushRequest || testCase || testResult || investigation || taskCard || planChanged || exploreChanged),
    spec.onProgress, spec.onOperation,
  );

  return { ...collected, proposal, report, pushRequest, testCase, testResult, investigation, taskCard, planChanged, exploreChanged };

};

// Stop the turn running under a key, if any. The turn ends with whatever the agent had done.
export const interrupt = async (key: string): Promise<boolean> => {

  const active = activeQueries.get(key);
  if (!active) return false;

  interruptedSessions.add(key);
  await active.interrupt();
  logger.info(`[agent-stop] Interrupted the turn for ${key}`);
  return true;

};

// Whether an agent turn is running under a key right now, for the web client's "working" state
export const isTurnRunning = (key: string): boolean => activeQueries.has(key);

export const activeTurnKeys = (): string[] => [...activeQueries.keys()];
