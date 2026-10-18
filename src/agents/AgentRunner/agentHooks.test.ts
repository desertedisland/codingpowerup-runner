// The agent's edit guards: rule files need the owner's confirmation, and uploads are read-only.
import path from 'path';
import { attachmentsRoot } from '../../attachments/attachments';
const UPLOAD_ROOT = attachmentsRoot();
import { buildEnvFileGuard, buildRuleFileGuard, buildUploadGuard } from './agentHooks';

const runGuard = async (approved: boolean, filePath: string) => {
  const guard = buildRuleFileGuard(approved);
  return guard.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: filePath }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '' } as never, 't1', { signal: new AbortController().signal });
};

describe('buildRuleFileGuard', () => {

  it('denies CLAUDE.md edits on both path styles when not approved', async () => {
    const posix = await runGuard(false, 'zen-api/src/CLAUDE.md') as { hookSpecificOutput?: { permissionDecision?: string } };
    const windows = await runGuard(false, 'C:\\Users\\x\\repo\\AGENTS.md') as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(posix.hookSpecificOutput?.permissionDecision).toEqual('deny');
    expect(windows.hookSpecificOutput?.permissionDecision).toEqual('deny');
  });

  it('allows other files, and rule files once approved', async () => {
    expect(await runGuard(false, 'zen-client/src/Header.tsx')).toEqual({});
    expect(await runGuard(false, 'docs/CLAUDE.md.bak')).toEqual({});
    expect(await runGuard(true, 'CLAUDE.md')).toEqual({});
  });

});

describe('buildUploadGuard', () => {

  const runUploadGuard = async (filePath: string) =>
    buildUploadGuard().hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '' } as never, 't1', { signal: new AbortController().signal });

  it('denies writes to the owner\'s uploads and allows the repo', async () => {
    const intoUploads = await runUploadGuard(path.join(UPLOAD_ROOT, 'session-1', 'mockup.png')) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(intoUploads.hookSpecificOutput?.permissionDecision).toEqual('deny');
    expect(await runUploadGuard('zen-client/src/Header.tsx')).toEqual({});
  });

});

describe('buildEnvFileGuard', () => {

  const runEnvGuard = async (toolName: string, filePath: string) =>
    buildEnvFileGuard().hooks[0]({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { file_path: filePath }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '' } as never, 't1', { signal: new AbortController().signal });

  it('denies reading or changing a .env file, on both path styles', async () => {
    for (const [toolName, filePath] of [['Read', '/w/goalzen/zen-api/.env'], ['Edit', 'zen-client/.env.local'], ['Write', 'C:\\w\\zen-api\\.env']]) {
      const result = await runEnvGuard(toolName, filePath) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(result.hookSpecificOutput?.permissionDecision).toEqual('deny');
    }
  });

  it('allows .env.example and files that only look similar', async () => {
    expect(await runEnvGuard('Read', 'zen-api/.env.example')).toEqual({});
    expect(await runEnvGuard('Read', 'zen-api/src/env.ts')).toEqual({});
    expect(await runEnvGuard('Read', '.envrc')).toEqual({});
  });

});
