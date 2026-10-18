// Every process the runner has started, on disk as well as in memory, so a runner that restarts
// finds the orphans of its last life and stops them before anything else: an application left
// running would hold its ports and keep serving a stale preview.
import fs from 'fs';
import path from 'path';
import { configDirectory, writePrivateFile } from '../platform/platform';
import logger from '../log/logger';
import { isAlive, killGroup, ManagedProcess } from './ManagedProcess';

export interface IRegisteredProcess {
  id: string;
  pid: number;
  label: string;
  cwd: string;
  startedAt: string;
}

export const processRegistryPath = (): string => path.join(configDirectory(), 'processes.json');

export class ProcessRegistry {

  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly file: string = processRegistryPath()) {}

  // Stop whatever a previous run of the runner left behind
  async cleanUpOrphans(): Promise<number> {
    let recorded: IRegisteredProcess[] = [];
    try {
      recorded = JSON.parse(fs.readFileSync(this.file, 'utf8')) as IRegisteredProcess[];
    } catch { /* nothing recorded */ }
    let stopped = 0;
    for (const entry of recorded) {
      if (isAlive(entry.pid)) {
        logger.warn(`[process] Stopping ${entry.label} (pid ${entry.pid}) left over from the last run`);
        await killGroup(entry.pid);
        stopped += 1;
      }
    }
    this.save();
    return stopped;
  }

  private save(): void {
    const entries: IRegisteredProcess[] = [...this.processes.values()]
      .filter((managed) => managed.isRunning() && managed.pid)
      .map((managed) => ({ id: managed.options.id, pid: managed.pid as number, label: managed.options.label, cwd: managed.options.cwd, startedAt: managed.startedAt.toISOString() }));
    writePrivateFile(this.file, `${JSON.stringify(entries, null, 2)}\n`);
  }

  start(options: ManagedProcess['options']): ManagedProcess {
    const managed = new ManagedProcess(options);
    this.processes.set(options.id, managed);
    this.save();
    managed.once('exit', () => this.save());
    return managed;
  }

  get(id: string): ManagedProcess | undefined { return this.processes.get(id); }

  all(): ManagedProcess[] { return [...this.processes.values()]; }

  async stop(id: string): Promise<boolean> {
    const managed = this.processes.get(id);
    if (!managed) return false;
    await managed.stop();
    this.processes.delete(id);
    this.save();
    return true;
  }

  // Everything, when the runner shuts down
  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }

}
