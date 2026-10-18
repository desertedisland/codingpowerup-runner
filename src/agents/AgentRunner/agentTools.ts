// The factory's in-process MCP server: the tools through which the agent hands back structured
// results (a proposal, a report) instead of prose the factory would have to parse. Each handler
// captures into the closure the runner passes in.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AUTHORIZABLE_PUSH_TARGETS, IBreakdownCapture, IClassifyCapture, IDraftItemCapture, IExploreToolHandlers, IFactoryProposal, IFactoryReport,
  IPlanCheckCapture, IPlanItemCapture, IPlanToolHandlers, IPlanUpdateCapture, IPushRequestCapture, ISandboxReportCapture, ITaskCardCapture,
  ITestCaseCapture, ITestInvestigationAnalysis, ITestResultCapture, PLAN_ITEM_SIZES, PLAN_ITEM_TYPES, TASK_CARD_TYPES,
} from '@yellowmelon/factory-global-types';

// The capture shapes are the protocol's (factory-global-types/src/runner): re-exported so the
// tool server's callers keep one import
export type {
  IBreakdownCapture, IClassifyCapture, IDraftItemCapture, IExploreToolHandlers, IPlanCheckCapture, IPlanItemCapture, IPlanToolHandlers, IPlanUpdateCapture,
  IPushRequestCapture, ISandboxReportCapture, ITaskCardCapture, ITestCaseCapture, ITestResultCapture,
};

export const FACTORY_SERVER_NAME = 'factory';
export const FACTORY_TOOL_PREFIX = `mcp__${FACTORY_SERVER_NAME}__`;
export const SUBMIT_PROPOSAL_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_proposal`;
export const SUBMIT_REPORT_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_report`;
export const REQUEST_PUSH_TOOL = `mcp__${FACTORY_SERVER_NAME}__request_push`;
export const SUBMIT_TEST_CASE_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_test_case`;
export const SUBMIT_TEST_RESULT_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_test_result`;
export const SUBMIT_INVESTIGATION_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_investigation`;
export const SUBMIT_TASK_CARD_TOOL = `mcp__${FACTORY_SERVER_NAME}__submit_task_card`;
export const UPDATE_PLAN_TOOL = `mcp__${FACTORY_SERVER_NAME}__update_plan`;
export const UPSERT_PLAN_ITEM_TOOL = `mcp__${FACTORY_SERVER_NAME}__upsert_plan_item`;
export const REMOVE_PLAN_ITEM_TOOL = `mcp__${FACTORY_SERVER_NAME}__remove_plan_item`;
export const CLASSIFY_REQUEST_TOOL = `mcp__${FACTORY_SERVER_NAME}__classify_request`;
export const PROPOSE_BREAKDOWN_TOOL = `mcp__${FACTORY_SERVER_NAME}__propose_breakdown`;
export const REPORT_SANDBOX_TOOL = `mcp__${FACTORY_SERVER_NAME}__report_sandbox`;
export const DRAFT_ITEM_TOOL = `mcp__${FACTORY_SERVER_NAME}__draft_item`;

const REQUEST_SIZES = ['S', 'M', 'L', 'XL'] as [string, ...string[]];

export interface IFactoryToolCaptures {
  onProposal?: (proposal: IFactoryProposal) => void;
  onReport?: (report: IFactoryReport) => void;
  onPushRequest?: (request: IPushRequestCapture) => void;
  onTestCase?: (testCase: ITestCaseCapture) => void;
  onTestResult?: (result: ITestResultCapture) => void;
  onInvestigation?: (analysis: ITestInvestigationAnalysis) => void;
  onTaskCard?: (card: ITaskCardCapture) => void;
  planTools?: IPlanToolHandlers;
  exploreTools?: IExploreToolHandlers;
}

const acknowledge = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const submitProposalTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_proposal',
    'Present your itemised implementation proposal to the owner for approval. Call this once you understand the request well enough to plan it; call it again with a revised plan if the owner asks for changes.',
    {
      title: z.string().describe('One line naming the change'),
      summary: z.string().describe('Two or three plain sentences on the approach'),
      items: z.array(z.object({
        title: z.string().describe('One concrete change'),
        detail: z.string().optional().describe('Files touched and anything non-obvious'),
      })),
      rulesAffected: z.array(z.string()).optional().describe('CLAUDE.md rules this change would alter'),
    },
    async (args) => {
      capture.onProposal && capture.onProposal(args);
      return acknowledge('Proposal recorded; it has been sent to the owner for approval.');
    },
  );

const submitReportTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_report',
    'Report the finished, committed implementation to the owner. Call this once the work is committed and the project checks pass; call it again if you make further changes afterwards.',
    {
      summary: z.string().describe('Two or three plain sentences on what was done'),
      changes: z.array(z.string()).describe('One line per meaningful change, naming the files touched'),
      testsAdded: z.array(z.string()).describe('Tests added or changed to guard the new behaviour'),
      rulesChanged: z.array(z.string()).describe('CLAUDE.md rules edited, if any were confirmed'),
      checksRun: z.array(z.string()).describe('Commands run to verify the work'),
      notes: z.string().optional().describe('Trade-offs, follow-ups, doubts, or rule changes that are needed but were not allowed'),
    },
    async (args) => {
      capture.onReport && capture.onReport(args);
      return acknowledge('Report recorded; it has been sent to the owner.');
    },
  );

const requestPushTool = (capture: IFactoryToolCaptures) =>
  tool(
    'request_push',
    'Call this when the owner asks to merge the session\'s branch into the project\'s main line (test for the products, main for zenfactory) and push it. ' +
    'Never call it for production or for a force-push - there is no way to ask for either through this tool. ' +
    'You never run the git merge or push yourself; this hands the request to the factory, which analyses the ' +
    'branches, shows the owner exactly what would happen, and only acts once they press the authorize button.',
    {
      targetBranch: z.enum(AUTHORIZABLE_PUSH_TARGETS as [string, ...string[]]).describe('The project\'s main line: test, or main for zenfactory'),
      reason: z.string().describe('One short sentence on what the owner asked for'),
    },
    async (args) => {
      capture.onPushRequest && capture.onPushRequest(args);
      return acknowledge('Push request recorded; the owner will be shown the branch analysis and asked to authorize it.');
    },
  );

const submitTestCaseTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_test_case',
    'Save the test case you have described as plain-English steps. Call this once you understand ' +
    'what the owner wants tested well enough to write it down; call it again with a revised version ' +
    'if the owner asks for changes before you are done.',
    {
      title: z.string().describe('One line naming the test'),
      steps: z.string().describe('The steps to carry out, in plain English, one per line'),
    },
    async (args) => {
      capture.onTestCase && capture.onTestCase(args);
      return acknowledge('Test case saved.');
    },
  );

const submitTestResultTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_test_result',
    'Report the outcome of running the test case through the browser. Call this once, after you ' +
    'have carried out every step (or hit one that failed and cannot continue).',
    {
      passed: z.boolean().describe('Whether the test as a whole passed'),
      summary: z.string().describe('One or two plain sentences on the outcome'),
      steps: z.array(z.object({
        description: z.string().describe('The step as carried out'),
        passed: z.boolean(),
        detail: z.string().optional().describe('What was seen, especially for a step that failed'),
        durationMs: z.number().optional().describe('How long the step took, in milliseconds, if you know'),
      })),
    },
    async (args) => {
      capture.onTestResult && capture.onTestResult(args);
      return acknowledge('Result recorded.');
    },
  );

const submitInvestigationTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_investigation',
    'Record your analysis of why the test run failed. Call it once you have read enough to say ' +
    'what went wrong; call it again if a later question changes your reading. Leave fix and patch ' +
    'out when you cannot honestly suggest a change.',
    {
      problem: z.string().describe('Two or three plain sentences on what went wrong and why, for a reader on a phone'),
      evidence: z.string().describe('The raw runner note, log line or observation the diagnosis rests on, verbatim'),
      fix: z.string().optional().describe('One or two sentences on how to fix it'),
      patch: z.string().optional().describe('The change as a short diff-style snippet (lines starting with - and +), with the file named on the first line'),
      confidence: z.enum(['high', 'medium', 'low']).optional().describe('How sure you are the fix is right'),
    },
    async (args) => {
      capture.onInvestigation && capture.onInvestigation(args);
      return acknowledge('Analysis recorded; it is shown to the owner beside this conversation.');
    },
  );

const submitTaskCardTool = (capture: IFactoryToolCaptures) =>
  tool(
    'submit_task_card',
    'Save the task card you have described for the project board. Call this once you understand ' +
    'what the owner wants well enough to write it down as a concrete task; call it again with a ' +
    'revised version if the owner asks for changes before you are done.',
    {
      title: z.string().describe('One line naming the card'),
      description: z.string().optional().describe('What the developer needs to know to do the work'),
      type: z.enum(TASK_CARD_TYPES as [string, ...string[]]).describe('bug, feature, task or chore'),
      checklist: z.array(z.string()).optional().describe('Concrete sub-tasks or steps, one per line'),
      acceptanceCriteria: z.string().optional().describe('How to tell the work is done'),
    },
    async (args) => {
      capture.onTaskCard && capture.onTaskCard(args);
      return acknowledge('Card saved.');
    },
  );

// The plan tools without handlers (a turn that is not a planning turn) answer with a refusal
// rather than crash; allowedTools keeps them out of such turns anyway
const noPlanHandlers = (): Promise<string> => Promise.resolve('Not in a planning session: this tool does nothing here.');

const updatePlanTool = (capture: IFactoryToolCaptures) =>
  tool(
    'update_plan',
    'Update the plan\'s head: its title, one-sentence summary, the plain-English status sentence the ' +
    'owner sees in their list of plans, and the stage it is at. Call it whenever any of these change, ' +
    'and at the end of every turn with a fresh status sentence.',
    {
      title: z.string().optional().describe('A short name for the plan'),
      summary: z.string().optional().describe('One sentence on what the plan delivers'),
      statusSentence: z.string().optional().describe('Plain English on where the plan stands, e.g. "4 items. Two are Ready; two still need their checks approved."'),
      stage: z.number().int().min(0).max(6).optional().describe('0 Intent, 1 Stories, 2 Challenge, 3 End picture, 4 Decompose, 5 Specify, 6 Add to board'),
    },
    async (args) => acknowledge(await (capture.planTools ? capture.planTools.updatePlan(args) : noPlanHandlers())),
  );

const upsertPlanItemTool = (capture: IFactoryToolCaptures) =>
  tool(
    'upsert_plan_item',
    'Create an item in the plan, or rewrite an existing one by giving its id. An item is one atomic ' +
    'unit of development: a plain-English description, a technical approach, a size, and checks ' +
    '(acceptance criteria as Given / When / Then, each with the concrete test it will be tested by). ' +
    'Rewriting replaces every field, and unticks any check whose text changed. Split an XL item by ' +
    'creating the smaller items and removing the big one.',
    {
      id: z.string().optional().describe('The id of the item to rewrite; leave out to create a new one'),
      type: z.enum(PLAN_ITEM_TYPES as [string, ...string[]]).describe('feature, bug, task or spike'),
      title: z.string().describe('One line naming the item'),
      description: z.string().describe('What it does, in plain English with no jargon'),
      how: z.string().describe('How it will be built: files, components, data, endpoints'),
      size: z.enum(PLAN_ITEM_SIZES as [string, ...string[]]).describe('S a few hours, M about a day, L a few days, XL too big: must be split'),
      checks: z.array(z.object({
        given: z.string().describe('The starting state, without the word Given'),
        when: z.string().describe('What happens, without the word When'),
        then: z.string().describe('What must be true afterwards, without the word Then'),
        testedBy: z.string().describe('The concrete browser test that proves it, one or two sentences'),
      })).describe('Acceptance criteria; a spike usually has one'),
    },
    async (args) => acknowledge(await (capture.planTools ? capture.planTools.upsertItem(args) : noPlanHandlers())),
  );

const removePlanItemTool = (capture: IFactoryToolCaptures) =>
  tool(
    'remove_plan_item',
    'Remove an item from the plan, for example after splitting it into smaller ones or when the owner drops it.',
    {
      id: z.string().describe('The id of the item to remove'),
    },
    async (args) => acknowledge(await (capture.planTools ? capture.planTools.removeItem(args.id) : noPlanHandlers())),
  );

// The Explore tools outside an Explore turn answer with a refusal rather than crash
const noExploreHandlers = (): Promise<string> => Promise.resolve('Not in an Explore session: this tool does nothing here.');

const classifyRequestTool = (capture: IFactoryToolCaptures) =>
  tool(
    'classify_request',
    'Size the owner\'s current request before acting on it: S (a few hours), M (about a day), L (a few ' +
    'days) or XL (too big to build blind). S and M put you in Build: edit the sandbox. L and XL put you ' +
    'in Plan: propose a breakdown and write no code. Until you call this, the editing tools are refused. ' +
    'Call it again if a later message changes the size of what is being asked.',
    {
      size: z.enum(REQUEST_SIZES).describe('S, M, L or XL'),
      reason: z.string().describe('A few words on why, e.g. "one component, no data changes"'),
    },
    async (args) => acknowledge(await (capture.exploreTools ? capture.exploreTools.classify(args) : noExploreHandlers())),
  );

const proposeBreakdownTool = (capture: IFactoryToolCaptures) =>
  tool(
    'propose_breakdown',
    'For an L or XL request: propose the breakdown into items the owner picks a first slice from. ' +
    'Each item is one atomic unit of development with a plain-English description and a size. ' +
    'Write no code before the owner has picked. Calling it again replaces the breakdown.',
    {
      title: z.string().describe('One line naming the whole request, e.g. "Habit tracker, first cut"'),
      items: z.array(z.object({
        title: z.string().describe('One line naming the item'),
        description: z.string().describe('What it does, in plain English'),
        size: z.enum(REQUEST_SIZES).describe('S, M or L; split anything XL further'),
        type: z.enum(TASK_CARD_TYPES as [string, ...string[]]).optional().describe('bug, feature, task or chore; feature when unsure'),
      })).min(2).max(8),
    },
    async (args) => acknowledge(await (capture.exploreTools ? capture.exploreTools.proposeBreakdown(args) : noExploreHandlers())),
  );

const reportSandboxTool = (capture: IFactoryToolCaptures) =>
  tool(
    'report_sandbox',
    'At the end of every Build turn in which files changed: say what the sandbox now holds. The ' +
    'factory adds git\'s own line counts; you give the working title, a note per file, and how the ' +
    'engineering checks you ran came out. Do not call it when nothing changed.',
    {
      title: z.string().describe('A short working title for the change, e.g. "Dark mode, following the system setting"'),
      files: z.array(z.object({
        path: z.string().describe('Path relative to the repository root'),
        note: z.string().optional().describe('One short line on what changed there'),
      })),
      checksPassing: z.number().int().min(0).optional().describe('Engineering checks (tests, typecheck) that pass'),
      checksTotal: z.number().int().min(0).optional().describe('Engineering checks run in all'),
    },
    async (args) => acknowledge(await (capture.exploreTools ? capture.exploreTools.reportSandbox(args) : noExploreHandlers())),
  );

const draftItemTool = (capture: IFactoryToolCaptures) =>
  tool(
    'draft_item',
    'The owner pressed Make this real: draft the work item from what this session built and decided. ' +
    'Give 2 to 4 checks as Given / When / Then, each testable from the product\'s own screens; the ' +
    'owner ticks the ones they agree with, and they become the item\'s acceptance criteria and its test.',
    {
      type: z.enum(TASK_CARD_TYPES as [string, ...string[]]).describe('bug, feature, task or chore'),
      size: z.enum(REQUEST_SIZES).describe('S, M or L'),
      title: z.string().describe('One line naming the item'),
      description: z.string().describe('What was built, in plain English'),
      checks: z.array(z.object({
        given: z.string().describe('The starting state, without the word Given'),
        when: z.string().describe('What happens, without the word When'),
        then: z.string().describe('What must be true afterwards, without the word Then'),
      })).min(1).max(6),
    },
    async (args) => acknowledge(await (capture.exploreTools ? capture.exploreTools.draftItem(args) : noExploreHandlers())),
  );

// All tools live on one server; which ones the agent may call is decided by allowedTools
export const buildFactoryToolServer = (capture: IFactoryToolCaptures) =>
  createSdkMcpServer({
    name: FACTORY_SERVER_NAME,
    version: '1.0.0',
    tools: [
      submitProposalTool(capture), submitReportTool(capture), requestPushTool(capture),
      submitTestCaseTool(capture), submitTestResultTool(capture), submitInvestigationTool(capture), submitTaskCardTool(capture),
      updatePlanTool(capture), upsertPlanItemTool(capture), removePlanItemTool(capture),
      classifyRequestTool(capture), proposeBreakdownTool(capture), reportSandboxTool(capture), draftItemTool(capture),
    ],
    // Always in the prompt: a turn must never have to find submit_proposal through tool search
    alwaysLoad: true,
  });
