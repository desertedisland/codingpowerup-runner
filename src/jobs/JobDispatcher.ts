// Jobs over the socket: RUN_JOB in, JOB_ACCEPTED at once, progress and operations as they
// happen, the agent's live tool calls as CALLBACK frames answered by CALLBACK_RESULT, and
// JOB_COMPLETED or JOB_FAILED at the end. Every job is in the ledger from acceptance to the
// moment its result is known to have reached the server, so a job is never run twice and a
// result is never lost to a dropped line.
import { randomUUID } from 'crypto';
import {
  ERunnerErrorCode, ERunnerJobKind, ERunnerMessageType, ICallbackPayload, ICallbackResultPayload, ICancelJobPayload, IJobAcceptedPayload, IJobCompletedPayload,
  IJobFailedPayload, IJobProgressPayload, IOperationPayload, IRunJobPayload, IRunnerEnvelope, IRunnerHeldJob, JOB_KIND_PERMISSIONS, TRunnerCallbackName,
} from '@yellowmelon/factory-global-types';
import logger from '../log/logger';
import { RunnerConnection } from '../connection/RunnerConnection';
import { handlers, JobError, toRunnerError } from './handlers';
import { JobLedger } from './JobLedger';
import { interrupt } from '../agents/AgentRunner/AgentRunner';
import { IAttachmentSource } from '../attachments/attachments';
import { ServedPreviews } from '../preview/servePreview';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface IPendingCallback {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class JobDispatcher {

  private readonly callbacks = new Map<string, IPendingCallback>();
  private readonly turnKeys = new Map<string, string>(); // jobId -> the agent turn's key, for cancel

  constructor(private readonly connection: RunnerConnection, private readonly ledger: JobLedger, private readonly attachments: IAttachmentSource, private readonly served: ServedPreviews) {

    // Anything the runner was in the middle of when it last stopped cannot be carried on
    const interrupted = ledger.markInterruptedByRestart();
    if (interrupted.length > 0) logger.warn(`[jobs] ${interrupted.length} job(s) were running when the runner last stopped; reported as failed`);

    connection.on('frame', (envelope: IRunnerEnvelope) => this.onFrame(envelope));
    // Once the server has heard the held jobs in REGISTER, the finished ones can go
    connection.on('registered', () => this.forgetReported());
    // A served preview the runner stopped on its own (idle, the application died) is reported
    served.onStopped((payload) => { this.send(ERunnerMessageType.PREVIEW_STOPPED, payload); });

  }

  heldJobs(): IRunnerHeldJob[] { return this.ledger.all(); }

  activeJobIds(): string[] { return this.ledger.active().map((job) => job.jobId); }

  private forgetReported(): void {
    this.ledger.all().filter((job) => job.status === 'succeeded' || job.status === 'failed').forEach((job) => this.ledger.forget(job.jobId));
  }

  private onFrame(envelope: IRunnerEnvelope): void {
    switch (envelope.type) {
      case ERunnerMessageType.RUN_JOB: this.run(envelope.payload as IRunJobPayload); return;
      case ERunnerMessageType.CANCEL_JOB: this.cancel((envelope.payload as ICancelJobPayload).jobId); return;
      case ERunnerMessageType.CALLBACK_RESULT: this.settleCallback(envelope.payload as ICallbackResultPayload); return;
      default: logger.debug(`[jobs] Ignoring a ${envelope.type} frame`);
    }
  }

  private send(type: ERunnerMessageType, payload: unknown): boolean { return this.connection.send(type, payload); }

  // The agent called a live tool: ask the server, wait for its answer
  private callback(jobId: string) {
    return (name: TRunnerCallbackName, payload: unknown): Promise<string> => new Promise<string>((resolve, reject) => {
      const callbackId = randomUUID();
      const timer = setTimeout(() => {
        this.callbacks.delete(callbackId);
        reject(new Error(`The factory did not answer ${name} in time`));
      }, CALLBACK_TIMEOUT_MS);
      this.callbacks.set(callbackId, { resolve, reject, timer });
      const frame: ICallbackPayload = { jobId, callbackId, name, payload };
      if (!this.send(ERunnerMessageType.CALLBACK, frame)) {
        clearTimeout(timer);
        this.callbacks.delete(callbackId);
        reject(new Error(`The factory is not connected, so ${name} cannot be answered`));
      }
    });
  }

  private settleCallback(result: ICallbackResultPayload): void {
    const pending = this.callbacks.get(result.callbackId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.callbacks.delete(result.callbackId);
    if (result.error) pending.reject(new Error(result.error)); else pending.resolve(result.reply || '');
  }

  private async run(job: IRunJobPayload): Promise<void> {

    // Already held: say so, never run it twice
    const held = this.ledger.get(job.jobId);
    if (held) {
      logger.info(`[jobs] ${job.jobId} ${job.kind} asked for again; it is ${held.status}`);
      const accepted: IJobAcceptedPayload = { jobId: job.jobId, alreadyHeld: held };
      this.send(ERunnerMessageType.JOB_ACCEPTED, accepted);
      if (held.status === 'succeeded' || held.status === 'failed') this.report(held);
      return;
    }

    const startedAt = new Date().toISOString();
    this.ledger.put({ jobId: job.jobId, kind: job.kind, status: 'running', startedAt });
    const accepted: IJobAcceptedPayload = { jobId: job.jobId };
    this.send(ERunnerMessageType.JOB_ACCEPTED, accepted);
    logger.info(`[jobs] ${job.jobId} ${job.kind} started${job.projectKey ? ` for ${job.projectKey}` : ''}`);

    if (job.kind === ERunnerJobKind.AGENT_TURN) this.turnKeys.set(job.jobId, (job.payload as { key: string }).key);

    const handler = handlers[job.kind] as (payload: unknown, context: unknown) => Promise<unknown>;
    let outcome: IRunnerHeldJob;

    try {
      if (!handler) throw new Error(`Unknown job kind ${job.kind}`);
      // The owner's switches, as the server told this runner; the server checks them too
      const needed = JOB_KIND_PERMISSIONS[job.kind];
      if (needed && this.connection.permissions[needed] === false) {
        throw new JobError(ERunnerErrorCode.PERMISSION_DENIED, `This runner is not allowed to ${needed.replace(/([A-Z])/g, ' $1').toLowerCase()}; an owner can switch it on from the Runners page.`);
      }
      const result = await handler(job.payload, {
        onProgress: (progress) => { const frame: IJobProgressPayload = { jobId: job.jobId, progress }; this.send(ERunnerMessageType.JOB_PROGRESS, frame); },
        onOperation: (operation) => { const frame: IOperationPayload = { jobId: job.jobId, operation }; this.send(ERunnerMessageType.OPERATION, frame); },
        onCallback: this.callback(job.jobId),
        attachments: this.attachments,
        served: this.served,
      });
      outcome = { jobId: job.jobId, kind: job.kind, status: 'succeeded', result, startedAt, finishedAt: new Date().toISOString() };
      logger.info(`[jobs] ${job.jobId} ${job.kind} succeeded`);
    } catch (err) {
      const error = toRunnerError(err);
      outcome = { jobId: job.jobId, kind: job.kind, status: 'failed', error, startedAt, finishedAt: new Date().toISOString() };
      logger.warn(`[jobs] ${job.jobId} ${job.kind} failed: ${error.code} ${error.message}`);
    } finally {
      this.turnKeys.delete(job.jobId);
    }

    this.ledger.put(outcome);
    this.report(outcome);

  }

  // Send the result; forget the job only once it has gone over an open socket. Otherwise it stays
  // in the ledger and is reported in the next REGISTER.
  private report(outcome: IRunnerHeldJob): void {
    let sent = false;
    if (outcome.status === 'succeeded') {
      const frame: IJobCompletedPayload = { jobId: outcome.jobId, result: outcome.result as never };
      sent = this.send(ERunnerMessageType.JOB_COMPLETED, frame);
    } else if (outcome.status === 'failed') {
      const frame: IJobFailedPayload = { jobId: outcome.jobId, error: outcome.error };
      sent = this.send(ERunnerMessageType.JOB_FAILED, frame);
    }
    if (sent) this.ledger.forget(outcome.jobId);
    else logger.warn(`[jobs] ${outcome.jobId} finished while disconnected; it will be reported on reconnect`);
  }

  // Stop a running agent turn; other kinds run to completion
  private cancel(jobId: string): void {
    const key = this.turnKeys.get(jobId);
    if (!key) { logger.info(`[jobs] Cancel for ${jobId}: nothing to interrupt`); return; }
    interrupt(key).then((interrupted) => logger.info(`[jobs] Cancel for ${jobId}: ${interrupted ? 'interrupted' : 'nothing running'}`));
  }

}
