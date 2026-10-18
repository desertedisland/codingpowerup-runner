// Deterministic guards on what the agent may touch, enforced by the harness rather than asked
// for in the prompt.
import { HookCallbackMatcher, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isInsideAttachmentsRoot as isInsideUploadRoot } from '../../attachments/attachments';

// Files that hold the owner's rules. Editing them is a decision the owner makes, not the agent.
const RULE_FILE_PATTERN = /(^|[\\/])(CLAUDE|AGENTS)[.]md$/i;

// PreToolUse hook on the editing tools: the owner's uploads are reference material the agent may
// read but never change. They sit outside the repo, so an edit there would also be lost work.
export const buildUploadGuard = (): HookCallbackMatcher => ({
  matcher: 'Edit|Write|MultiEdit|NotebookEdit',
  hooks: [
    async (input) => {

      const toolInput = (input as PreToolUseHookInput).tool_input as { file_path?: string } | undefined;
      if (!toolInput?.file_path || !isInsideUploadRoot(toolInput.file_path)) return {};

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Uploaded files are read-only. Put any changes in the repository instead.',
        },
      };

    },
  ],
});

// A git-ignored environment file: .env, .env.local and so on, but not the tracked .env.example
const ENV_FILE_PATTERN = /(^|[\\/])\.env(\.(?!example$|sample$)[\w-]+)?$/i;

// PreToolUse hook on the file tools: the product's .env files hold its secrets, and in a worktree
// they are links to the one real file in the checkout, so an edit there would change the
// product's own config. The agent may neither read nor change them (droplet rule 5).
export const buildEnvFileGuard = (): HookCallbackMatcher => ({
  matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit',
  hooks: [
    async (input) => {

      const toolInput = (input as PreToolUseHookInput).tool_input as { file_path?: string } | undefined;
      if (!toolInput?.file_path || !ENV_FILE_PATTERN.test(toolInput.file_path)) return {};

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '.env files hold the product\'s secrets and are off limits. Use .env.example to see which variables exist, and name any new variable in your report for the owner to add.',
        },
      };

    },
  ],
});

// PreToolUse hook on the editing tools: deny any write to a rule file unless the owner has
// confirmed the rule changes for this session.
export const buildRuleFileGuard = (rulesChangeApproved: boolean): HookCallbackMatcher => ({
  matcher: 'Edit|Write|MultiEdit|NotebookEdit',
  hooks: [
    async (input) => {

      const toolInput = (input as PreToolUseHookInput).tool_input as { file_path?: string } | undefined;
      const filePath = toolInput?.file_path || '';

      if (!RULE_FILE_PATTERN.test(filePath) || rulesChangeApproved) {
        return {};
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'CLAUDE.md and AGENTS.md changes need the owner\'s confirmation. Describe the needed rule change in your report notes instead of editing the file.',
        },
      };

    },
  ],
});

// PreToolUse hook for Explore turns: code may change only while the agent is in Build, that is
// once it has sized the request small enough to build. Before classify_request, and in Plan,
// the editing tools and the shell are refused with the reason, so an L/XL request is never
// half-built before the owner picks a slice. `canBuild` reads the live mode the flow keeps.
export const buildModeGuard = (canBuild: () => boolean | Promise<boolean>): HookCallbackMatcher => ({
  matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
  hooks: [
    async () => {

      if (await canBuild()) return {};

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Code tools are off until the request is sized S or M with classify_request (or the owner picks a slice to build). Read, size, or propose a breakdown instead.',
        },
      };

    },
  ],
});
