// Workspace against a real throwaway git repo: the branch choice, the dirty-tree and protected-
// branch refusals, and the diff against the session's base commit.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { IFactoryProject } from '@yellowmelon/factory-global-types';
import {
  analyzeBranchPush, changedFilesSummary, commitAll, createReleaseBranch, createWorkspace, inspectCheckout, mergeAndPush,
} from './Workspace';
const TEST_ORGANISATION_ID = '64f1aaaabbbbccccdddd0000';

// Point the registry's project path at a temp folder instead of ~/dev
jest.mock('../../repositories/projectConfig', () => ({
  listLocalProjectConfigs: () => [],
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  resolveProjectPath: (project: { key: string }) => require('path').join(require('os').tmpdir(), 'zenfactory-ws-test', project.key),
}));

const project: IFactoryProject = {
  organisationId: TEST_ORGANISATION_ID, key: 'sample',
  name: 'Sample',
  defaultBranch: 'main',
  enabled: true,
};

const repoPath = path.join(os.tmpdir(), 'zenfactory-ws-test', 'sample');
const SESSION_ID = '64f1aaaabbbbccccdddd1234';

const git = (...args: string[]): string => execFileSync('git', ['-C', repoPath, ...args]).toString().trim();

// A fresh repo on main with one commit, before every test
beforeEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});

afterAll(() => {
  fs.rmSync(path.join(os.tmpdir(), 'zenfactory-ws-test'), { recursive: true, force: true });
});

describe('analyzeBranchPush and mergeAndPush', () => {

  // A bare "origin" the test repo can actually fetch from and push to
  const originPath = path.join(os.tmpdir(), 'zenfactory-ws-test', 'origin.git');

  beforeEach(() => {
    fs.rmSync(originPath, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath]);
    git('remote', 'add', 'origin', originPath);
    git('push', '-q', 'origin', 'main');
  });

  it('reports a clean merge with no warnings', async () => {

    git('checkout', '-q', '-b', 'feature-x');
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature work');

    const analysis = await analyzeBranchPush(repoPath, 'feature-x', 'main');

    expect(analysis).toEqual({
      targetBranch: 'main', sourceBranch: 'feature-x', hasUncommittedChanges: false,
      targetBehindRemote: 0, sourceAheadOfTarget: 1, likelyConflict: false,
    });

  });

  it('flags uncommitted changes and a target behind the remote', async () => {

    git('checkout', '-q', '-b', 'feature-x');
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature work');

    // Someone else pushed to origin/main since this checkout last saw it
    execFileSync('git', ['clone', '-q', originPath, path.join(os.tmpdir(), 'zenfactory-ws-test', 'other-clone')]);
    const otherClone = path.join(os.tmpdir(), 'zenfactory-ws-test', 'other-clone');
    fs.writeFileSync(path.join(otherClone, 'elsewhere.txt'), 'someone else\n');
    execFileSync('git', ['-C', otherClone, 'add', '-A']);
    execFileSync('git', ['-C', otherClone, 'commit', '-q', '-m', 'someone else\'s change']);
    execFileSync('git', ['-C', otherClone, 'push', '-q', 'origin', 'main']);

    fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'uncommitted\n');

    const analysis = await analyzeBranchPush(repoPath, 'feature-x', 'main');

    expect(analysis.hasUncommittedChanges).toBe(true);
    expect(analysis.targetBehindRemote).toEqual(1);

  });

  it('detects a conflicting merge without touching the working tree', async () => {

    git('checkout', '-q', '-b', 'feature-y');
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'feature change\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature change');

    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'main change\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main change');
    git('checkout', '-q', 'feature-y');

    const analysis = await analyzeBranchPush(repoPath, 'feature-y', 'main');

    expect(analysis.likelyConflict).toBe(true);
    // Read-only: still on feature-y, nothing left half-merged
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('feature-y');
    expect(git('status', '--porcelain')).toEqual('');

  });

  it('merges the source branch into the target, pushes it, and returns to the source branch', async () => {

    git('checkout', '-q', '-b', 'feature-z');
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature work');

    await mergeAndPush(repoPath, 'feature-z', 'main');

    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('feature-z');
    const originLog = execFileSync('git', ['-C', originPath, 'log', '--oneline', 'main']).toString();
    expect(originLog).toMatch(/feature work/);

  });

  it('never pushes to production, or anywhere but main, regardless of what is asked', async () => {

    await expect(mergeAndPush(repoPath, 'main', 'production')).rejects.toThrow(/not a branch the factory may push to/);
    await expect(mergeAndPush(repoPath, 'main', 'some-other-branch')).rejects.toThrow(/not a branch the factory may push to/);

  });

});

describe('createWorkspace', () => {

  it('checks out a new factory branch in the repo itself', async () => {

    const workspace = await createWorkspace(project, SESSION_ID, 'new');

    expect(workspace.branch).toEqual('factory-dddd1234');
    expect(workspace.workingPath).toEqual(repoPath);
    expect(workspace.baseCommit).toEqual(git('rev-parse', 'main'));
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('factory-dddd1234');
    expect(git('worktree', 'list').split('\n')).toHaveLength(1); // no extra worktrees

  });

  it('uses an owner-chosen branch name, and refuses an invalid or protected one', async () => {

    await expect(createWorkspace(project, SESSION_ID, 'new', 'bad name..')).rejects.toThrow(/not a valid branch name/);
    await expect(createWorkspace(project, SESSION_ID, 'new', 'production')).rejects.toThrow(/never works on directly/);

    const workspace = await createWorkspace(project, SESSION_ID, 'new', 'invite-flow');
    expect(workspace.branch).toEqual('invite-flow');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('invite-flow');

  });

  it('cuts a new branch from the branch checked out, not from the default branch', async () => {

    git('checkout', '-q', '-b', 'v1.2.2');
    fs.writeFileSync(path.join(repoPath, 'release.txt'), 'release work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'release work');
    const releaseHead = git('rev-parse', 'HEAD');

    const workspace = await createWorkspace(project, SESSION_ID, 'new');

    expect(workspace.baseCommit).toEqual(releaseHead);
    expect(fs.existsSync(path.join(repoPath, 'release.txt'))).toBe(true);

  });

  it('refuses a new branch when the tree has uncommitted changes', async () => {

    fs.writeFileSync(path.join(repoPath, 'README.md'), 'edited\n');
    await expect(createWorkspace(project, SESSION_ID, 'new')).rejects.toThrow(/uncommitted changes on main/);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('main');

  });

  it('refuses to stay on the default branch', async () => {

    await expect(createWorkspace(project, SESSION_ID, 'current')).rejects.toThrow(/Sample is on main, which the factory never works on directly/);
    expect((await inspectCheckout(project)).canStay).toBe(false);

  });

  it('refuses to stay on production even when it is not the default', async () => {

    git('checkout', '-q', '-b', 'production');
    expect((await inspectCheckout(project)).canStay).toBe(false);

  });

  it('stays on a feature branch and diffs only against where the session started', async () => {

    git('checkout', '-q', '-b', 'feature-x');
    fs.writeFileSync(path.join(repoPath, 'earlier.txt'), 'owner work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'owner work');

    const workspace = await createWorkspace(project, SESSION_ID, 'current');
    expect(workspace.branch).toEqual('feature-x');

    fs.writeFileSync(path.join(repoPath, 'session.txt'), 'session work\n');
    await commitAll(repoPath, 'session work');

    const summary = await changedFilesSummary(repoPath, workspace.baseCommit);
    expect(summary).toMatch(/session\.txt/);
    expect(summary).not.toMatch(/earlier\.txt/);

  });

});

describe('release branches', () => {

  it('cuts a release branch from main as a ref only, leaving the checkout alone', async () => {

    const mainHead = git('rev-parse', 'main');
    git('checkout', '-q', '-b', 'owner-work');
    fs.writeFileSync(path.join(repoPath, 'wip.txt'), 'uncommitted\n');

    const workspace = await createReleaseBranch(project, 'reminder-time-002');

    expect(workspace.branch).toEqual('reminder-time-002');
    expect(workspace.baseCommit).toEqual(mainHead);
    expect(git('rev-parse', 'reminder-time-002')).toEqual(mainHead);
    // The owner's checkout did not move, and their uncommitted file is still there
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toEqual('owner-work');
    expect(fs.existsSync(path.join(repoPath, 'wip.txt'))).toBe(true);

  });

  it('refuses a name that already exists', async () => {
    git('branch', 'reminder-time-001');
    await expect(createReleaseBranch(project, 'reminder-time-001')).rejects.toThrow(/already exists/);
  });

});
