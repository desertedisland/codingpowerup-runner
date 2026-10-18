// Everything that builds goes through here: check runs and (later) deploys from every session. At
// most FACTORY_HEAVY_CONCURRENCY jobs (default 2) run at once and the rest wait in order, because
// the dev droplet is 4 GB / 2 vCPU and one API tsc build alone takes about 550 MB. Conversations
// and agent turns do not use this queue; they are cheap and can overlap.
import { IHeavyQueueStatus } from '@yellowmelon/factory-global-types';
import logger from '../log/logger';
import { EventEmitter } from 'events';

// Whoever reports to the server listens here: every change to the queue
export const queueEvents = new EventEmitter();

const DEFAULT_CONCURRENCY = 2;

interface IHeavyJob {
  label: string;
  start: () => void;
}

const runningJobs: IHeavyJob[] = [];
const waitingJobs: IHeavyJob[] = [];

// Read on every use, so the setting can change without a restart and tests can set it.
// Anything that is not a whole number of at least 1 falls back to the default.
export const heavyConcurrency = (): number => {
  const configured = Number(process.env.FACTORY_HEAVY_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 ? configured : DEFAULT_CONCURRENCY;
};

export const heavyQueueStatus = (): IHeavyQueueStatus => ({
  running: runningJobs.map((job) => job.label),
  waiting: waitingJobs.map((job) => job.label),
  concurrency: heavyConcurrency(),
});

// Every open browser stream hears about every queue change, whichever session it watches
const announceQueue = (): void => { queueEvents.emit('change', heavyQueueStatus()); };

// Start waiting jobs while there are free slots
const startWaitingJobs = (): void => {
  while (runningJobs.length < heavyConcurrency() && waitingJobs.length > 0) {
    const job = waitingJobs.shift();
    runningJobs.push(job);
    job.start();
  }
};

// Run `work` as soon as a slot is free. `onQueued` fires with the labels ahead of it (running and
// waiting), but only when it has to wait, so the caller can tell the owner.
export const enqueueHeavyWork = <T>(
  label: string,
  work: () => Promise<T>,
  onQueued?: (ahead: string[]) => void,
): Promise<T> => new Promise<T>((resolve, reject) => {

  const status = heavyQueueStatus();
  if (status.running.length >= status.concurrency) {
    const ahead = [...status.running, ...status.waiting];
    logger.info(`[heavy-queue] "${label}" queued behind: ${ahead.join(', ')}`);
    onQueued && onQueued(ahead);
  }

  const job: IHeavyJob = {
    label,
    start: () => {
      logger.info(`[heavy-queue] "${label}" started (${runningJobs.length} of ${heavyConcurrency()} running)`);
      announceQueue();
      // A failed build must not block the queue: the slot is freed whatever the outcome, even when
      // `work` throws before returning a promise
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        runningJobs.splice(runningJobs.indexOf(job), 1);
        logger.info(`[heavy-queue] "${label}" finished`);
        startWaitingJobs();
        announceQueue();
      });
    },
  };

  waitingJobs.push(job);
  announceQueue();
  startWaitingJobs();

});
