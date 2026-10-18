// Worktrees against a real throwaway git repo: a worktree per session on its own branch with
// the checkout untouched, node_modules linked in, landing on the release (plain and with a
// conflict, and with the release checked out somewhere), and removal.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { IFactoryProject } from '@yellowmelon/factory-global-types';
import { createSessionWorktree, landOnRelease, linkDependencies, MergeConflictError, removeSessionWorktree, worktreePathFor } from './Worktrees';
const TEST_ORGANISATION_ID = '64f1aaaabbbbccccdddd0000';

const TEST_ROOT = path.join(os.tmpdir(), 'zenfactory-wt-test');
const WORKTREE_ROOT = path.join(TEST_ROOT, 'worktrees');

// The registry's project path and the worktree root both point into the temp folder
jest.mock('../../repositories/projectConfig', () => ({
  listLocalProjectConfigs: () => [],
  resolveProjectPath: (project: { key: string }) => require('path').join(require('os').tmpdir(), 'zenfactory-wt-test', project.key),
}));
jest.mock('../../config/paths', () => ({
  worktreeRoot: () => require('path').join(require('os').tmpdir(), 'zenfactory-wt-test', 'worktrees'),
  worktreeRootProblem: () => null,
}));

const project: IFactoryProject = { organisationId: TEST_ORGANISATION_ID, key: 'sample', name: 'Sample', defaultBranch: 'main', enabled: true };
const repoPath = path.join(TEST_ROOT, 'sample');
const SESSION_A = '64f1aaaabbbbccccdddd1234';
const SESSION_B = '64f1aaaabbbbccccdddd5678';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args]).toString().trim();
const write = (cwd: string, file: string, content: string) => fs.writeFileSync(path.join(cwd, file), content);
const commitAll = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', message); };

// A fresh repo on main with one commit, a release branch, and a node_modules to link
beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test');
  write(repoPath, 'README.md', 'hello\n');
  write(repoPath, '.gitignore', 'node_modules\n');
  fs.mkdirSync(path.join(repoPath, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'api', 'node_modules'), { recursive: true });
  commitAll(repoPath, 'initial');
  git(repoPath, 'branch', 'reminder-time-001', 'main');
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('createSessionWorktree', () => {

  it('links the checkout\'s git-ignored .env files, never a tracked one', async () => {

    write(repoPath, '.gitignore', 'node_modules\n.env\n');
    write(path.join(repoPath, 'api'), 'placeholder.txt', 'x\n');
    write(path.join(repoPath, 'api'), '.env.example', 'API_PORT=\n');
    commitAll(repoPath, 'ignore env, track the example');
    write(path.join(repoPath, 'api'), '.env', 'API_PORT=4700\n');
    write(path.join(repoPath, 'api'), '.env.local', 'NOT_IGNORED=1\n');

    const workspace = await createSessionWorktree(project, SESSION_A, 'sandbox-dddd1234', 'main');
    const envLink = path.join(workspace.workingPath, 'api', '.env');

    expect(fs.lstatSync(envLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(envLink)).toEqual(fs.realpathSync(path.join(repoPath, 'api', '.env')));
    expect(fs.lstatSync(path.join(workspace.workingPath, 'api', '.env.example')).isSymbolicLink()).toBe(false);
    // .env.local is not ignored here, so it is not linked (it would show up as a change)
    expect(fs.existsSync(path.join(workspace.workingPath, 'api', '.env.local'))).toBe(false);
    expect(git(workspace.workingPath, 'status', '--porcelain')).toEqual('');

  });

  it('makes a worktree on a new branch off the base, links node_modules, and leaves the checkout alone', async () => {

    write(repoPath, 'wip.txt', 'owner work\n');
    const workspace = await createSessionWorktree(project, SESSION_A, 'reminder-time-001--dddd1234', 'reminder-time-001');

    expect(workspace.workingPath).toEqual(worktreePathFor(project, SESSION_A));
    expect(workspace.branch).toEqual('reminder-time-001--dddd1234');
    expect(workspace.baseCommit).toEqual(git(repoPath, 'rev-parse', 'reminder-time-001'));
    expect(git(workspace.workingPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toEqual('reminder-time-001--dddd1234');
    expect(fs.existsSync(path.join(workspace.workingPath, 'node_modules', 'left-pad'))).toBe(true);
    expect(fs.existsSync(path.join(workspace.workingPath, 'api', 'node_modules'))).toBe(true);

    // The owner's checkout: still on main, uncommitted file untouched
    expect(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toEqual('main');
    expect(fs.existsSync(path.join(repoPath, 'wip.txt'))).toBe(true);

    // Two sessions at once, each in its own worktree
    const second = await createSessionWorktree(project, SESSION_B, 'sandbox-dddd5678', 'main');
    expect(second.workingPath).not.toEqual(workspace.workingPath);
    expect(git(repoPath, 'worktree', 'list').split('\n')).toHaveLength(3);

  });

  it('links nothing that is already there', () => {
    const target = path.join(TEST_ROOT, 'elsewhere');
    fs.mkdirSync(path.join(target, 'node_modules'), { recursive: true });
    expect(linkDependencies(repoPath, target)).toEqual([path.join('api', 'node_modules')]);
  });

});

describe('landOnRelease', () => {

  it('merges the release into the session branch and moves the release ref forward', async () => {

    const workspace = await createSessionWorktree(project, SESSION_A, 'reminder-time-001--dddd1234', 'reminder-time-001');
    write(workspace.workingPath, 'feature.txt', 'session work\n');
    commitAll(workspace.workingPath, 'session work');

    // Meanwhile the release moved on (another session landed)
    git(repoPath, 'checkout', '-q', 'reminder-time-001');
    write(repoPath, 'other.txt', 'other session\n');
    commitAll(repoPath, 'other session');
    git(repoPath, 'checkout', '-q', 'main');

    const head = await landOnRelease(project, workspace.workingPath, 'reminder-time-001');

    expect(git(repoPath, 'rev-parse', 'reminder-time-001')).toEqual(head);
    expect(git(repoPath, 'show', 'reminder-time-001:feature.txt')).toEqual('session work');
    expect(git(repoPath, 'show', 'reminder-time-001:other.txt')).toEqual('other session');

  });

  it('fast-forwards the release in the checkout that has it checked out', async () => {

    const workspace = await createSessionWorktree(project, SESSION_A, 'reminder-time-001--dddd1234', 'reminder-time-001');
    write(workspace.workingPath, 'feature.txt', 'session work\n');
    commitAll(workspace.workingPath, 'session work');
    git(repoPath, 'checkout', '-q', 'reminder-time-001');

    const head = await landOnRelease(project, workspace.workingPath, 'reminder-time-001');

    expect(git(repoPath, 'rev-parse', 'HEAD')).toEqual(head);
    expect(fs.existsSync(path.join(repoPath, 'feature.txt'))).toBe(true);

  });

  it('throws a MergeConflictError naming the files and leaves the merge in progress', async () => {

    const workspace = await createSessionWorktree(project, SESSION_A, 'reminder-time-001--dddd1234', 'reminder-time-001');
    write(workspace.workingPath, 'README.md', 'session version\n');
    commitAll(workspace.workingPath, 'session edit');
    git(repoPath, 'checkout', '-q', 'reminder-time-001');
    write(repoPath, 'README.md', 'release version\n');
    commitAll(repoPath, 'release edit');
    git(repoPath, 'checkout', '-q', 'main');

    const releaseBefore = git(repoPath, 'rev-parse', 'reminder-time-001');
    await expect(landOnRelease(project, workspace.workingPath, 'reminder-time-001')).rejects.toBeInstanceOf(MergeConflictError);
    await expect(landOnRelease(project, workspace.workingPath, 'reminder-time-001').catch((err) => err.output)).resolves.toMatch(/README\.md/);

    expect(git(repoPath, 'rev-parse', 'reminder-time-001')).toEqual(releaseBefore);
    expect(fs.readFileSync(path.join(workspace.workingPath, 'README.md'), 'utf8')).toMatch(/<<<<<<</);

    // The agent resolves and commits; landing then goes through
    write(workspace.workingPath, 'README.md', 'both versions\n');
    commitAll(workspace.workingPath, 'resolve');
    const head = await landOnRelease(project, workspace.workingPath, 'reminder-time-001');
    expect(git(repoPath, 'rev-parse', 'reminder-time-001')).toEqual(head);

  });

});

describe('removeSessionWorktree', () => {

  it('commits leftovers, removes the worktree, and deletes the branch only when asked', async () => {

    const kept = await createSessionWorktree(project, SESSION_A, 'reminder-time-001--dddd1234', 'reminder-time-001');
    write(kept.workingPath, 'leftover.txt', 'not committed\n');
    await removeSessionWorktree(project, kept.workingPath);
    expect(fs.existsSync(kept.workingPath)).toBe(false);
    expect(git(repoPath, 'show', 'reminder-time-001--dddd1234:leftover.txt')).toEqual('not committed');

    const sandbox = await createSessionWorktree(project, SESSION_B, 'sandbox-dddd5678', 'main');
    await removeSessionWorktree(project, sandbox.workingPath, { deleteBranch: 'sandbox-dddd5678' });
    expect(fs.existsSync(sandbox.workingPath)).toBe(false);
    expect(git(repoPath, 'branch', '--list', 'sandbox-dddd5678')).toEqual('');
    expect(git(repoPath, 'worktree', 'list').split('\n')).toHaveLength(1);

    // Already gone: nothing to do, no error
    await removeSessionWorktree(project, sandbox.workingPath);

  });

});
