// What a sandbox has changed since its base commit, working tree included, so uncommitted work
// counts: git's numstat for tracked changes plus every untracked file counted as added lines.
// Binary files have no line counts and report zero.
import fs from 'fs';
import path from 'path';
import { ISandboxFileStat, ISandboxStats } from '@yellowmelon/factory-global-types';
import { git } from '../Workspace/Workspace';

// The shapes are the protocol's (the sandbox_stats job's result)
export type { ISandboxFileStat, ISandboxStats };

const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

// Lines in an untracked file, or zero when it cannot be read as text
const countLines = (filePath: string): number => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return 0;
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.includes('\0')) return 0;
    return text.split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
};

const parseNumstat = (output: string): ISandboxFileStat[] =>
  output.split('\n').filter((line) => line.trim().length > 0).map((line) => {
    const [adds, dels, ...rest] = line.split('\t');
    return { path: rest.join('\t'), adds: Number(adds) || 0, dels: Number(dels) || 0 };
  });

export const sandboxStats = async (workingPath: string, base: string): Promise<ISandboxStats> => {

  const numstat = await git(workingPath, ['diff', '--numstat', base]).catch(() => '');
  const untracked = await git(workingPath, ['ls-files', '--others', '--exclude-standard']).catch(() => '');

  const files = parseNumstat(numstat);
  untracked.split('\n').filter((line) => line.trim().length > 0).forEach((relative) => {
    files.push({ path: relative, adds: countLines(path.join(workingPath, relative)), dels: 0 });
  });

  return {
    files,
    adds: files.reduce((total, file) => total + file.adds, 0),
    dels: files.reduce((total, file) => total + file.dels, 0),
  };

};
