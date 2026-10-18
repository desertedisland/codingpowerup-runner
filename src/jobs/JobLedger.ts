// The jobs this runner holds, on disk, so a runner that restarts still knows what it was doing
// and can tell the server on reconnect (at most once: a job the runner lists is never sent
// again). A job leaves the ledger once its result has been sent over an open socket, or once
// the server has heard it in a REGISTER.
import fs from 'fs';
import path from 'path';
import { IRunnerHeldJob } from '@yellowmelon/factory-global-types';
import { configDirectory, writePrivateFile } from '../platform/platform';

export const ledgerFilePath = (): string => path.join(configDirectory(), 'jobs.json');

export class JobLedger {

  private jobs = new Map<string, IRunnerHeldJob>();

  constructor(private readonly file: string = ledgerFilePath()) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as IRunnerHeldJob[];
      if (Array.isArray(parsed)) parsed.forEach((job) => this.jobs.set(job.jobId, job));
    } catch { /* no ledger yet */ }
  }

  private save(): void {
    writePrivateFile(this.file, `${JSON.stringify([...this.jobs.values()], null, 2)}\n`);
  }

  has(jobId: string): boolean { return this.jobs.has(jobId); }

  get(jobId: string): IRunnerHeldJob | undefined { return this.jobs.get(jobId); }

  all(): IRunnerHeldJob[] { return [...this.jobs.values()]; }

  active(): IRunnerHeldJob[] { return this.all().filter((job) => job.status === 'accepted' || job.status === 'running'); }

  put(job: IRunnerHeldJob): void {
    this.jobs.set(job.jobId, job);
    this.save();
  }

  forget(jobId: string): void {
    if (this.jobs.delete(jobId)) this.save();
  }

  // A runner that restarted cannot carry on an agent turn or a build it was in the middle of
  markInterruptedByRestart(): IRunnerHeldJob[] {
    const interrupted = this.active();
    interrupted.forEach((job) => this.jobs.set(job.jobId, {
      ...job, status: 'failed', finishedAt: new Date().toISOString(),
      error: { code: 'FAILED' as IRunnerHeldJob['error']['code'], message: 'The runner restarted while this job was running' },
    }));
    if (interrupted.length > 0) this.save();
    return interrupted;
  }

}
