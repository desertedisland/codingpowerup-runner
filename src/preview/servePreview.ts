// The `serve` preview strategy: run the application from a working copy on ports of the runner's
// choosing, wait until it answers, and hand back where it listens. One served preview per
// project: a second replaces the first. A preview nobody has asked about for a while is stopped,
// and the server is told (PREVIEW_STOPPED), as it is when the application dies or the runner
// shuts down.
import { IApplicationPorts, IPreviewStoppedPayload, IRunnerProjectRef, IStartApplicationResult, IStartPreviewPayload } from '@yellowmelon/factory-global-types';
import { readRunnerConfig } from '../config/RunnerConfig';
import { configFilePath } from '../platform/platform';
import { localProjectConfig, resolveProjectPath } from '../repositories/projectConfig';
import { headShortSha } from '../git/Workspace/Workspace';
import { linkCheckoutFiles, releasePreviewPathFor, prepareReleasePreview } from '../git/Worktrees/Worktrees';
import { ProcessRegistry } from '../processes/ProcessRegistry';
import { allocatePorts, DEFAULT_PORT_RANGE } from '../application/ports';
import { DEFAULT_READINESS, fillPorts, waitUntilReady } from '../application/HealthCheck';
import logger from '../log/logger';

const DEFAULT_IDLE_MINUTES = 30;

export interface IServedPreview {
  previewId: string;
  projectKey: string;
  processId: string;
  ports: IApplicationPorts;
  localUrl: string;
  reachableUrl?: string;
  workingPath: string;
  commit?: string;
  startedAt: Date;
  lastTouchedAt: Date;
  idleTimer?: NodeJS.Timeout;
  isPreview: boolean; // the project's preview slot, as opposed to an application started for a test batch
}

export type TPreviewStoppedListener = (payload: IPreviewStoppedPayload) => void;

export class ServedPreviews {

  private readonly previews = new Map<string, IServedPreview>(); // by previewId
  private readonly listeners = new Set<TPreviewStoppedListener>();

  constructor(private readonly registry: ProcessRegistry) {}

  onStopped(listener: TPreviewStoppedListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private capacity() {
    return readRunnerConfig(configFilePath()).capacity || {};
  }

  private takenPorts(): Set<number> {
    const taken = new Set<number>();
    this.previews.forEach((preview) => { taken.add(preview.ports.api); taken.add(preview.ports.client); });
    return taken;
  }

  private reachableUrlFor(ports: IApplicationPorts): string | undefined {
    const host = this.capacity().reachableHost;
    return host ? `http://${host}:${ports.client}` : undefined;
  }

  // The project's one preview (applications started for other reasons do not count)
  byProject(projectKey: string): IServedPreview | undefined {
    return [...this.previews.values()].find((preview) => preview.projectKey === projectKey && preview.isPreview);
  }

  get(previewId: string): IServedPreview | undefined { return this.previews.get(previewId); }

  all(): IServedPreview[] { return [...this.previews.values()]; }

  // Something asked about the preview (a relayed request, a viewer): it is not idle
  touch(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (!preview) return;
    preview.lastTouchedAt = new Date();
    this.armIdleTimer(preview);
  }

  private armIdleTimer(preview: IServedPreview): void {
    if (preview.idleTimer) clearTimeout(preview.idleTimer);
    const minutes = this.capacity().previewIdleMinutes ?? DEFAULT_IDLE_MINUTES;
    preview.idleTimer = setTimeout(() => { this.stop(preview.previewId, `idle for ${minutes} minutes`); }, minutes * 60 * 1000);
    preview.idleTimer.unref?.();
  }

  // Start the application of a working copy and wait until it answers. A preview takes the
  // project's one preview slot (the previous one makes way) and stops when idle; an application
  // for something else (a test batch) takes a slot of its own and runs until it is stopped.
  async start(payload: IStartPreviewPayload, onProgress?: (note: string) => void, options: { exclusive?: boolean; idles?: boolean } = {}): Promise<IStartApplicationResult & { commit?: string; workingPath: string }> {

    const { project, source, label } = payload;
    const entry = localProjectConfig(project);
    if (!entry?.startCommand) throw new Error(`${project.name} has no start command on this runner, so it cannot be served.`);

    const exclusive = options.exclusive !== false;
    const previewId = payload.previewId || `${project.key}-${Date.now()}`;

    // One preview per project: the previous one makes way
    const existing = exclusive ? this.byProject(project.key) : undefined;
    if (existing) await this.stop(existing.previewId, `replaced by ${label}`, false);

    let workingPath: string;
    if (source.kind === 'session') workingPath = source.workingPath;
    else if (source.kind === 'release') { workingPath = releasePreviewPathFor(project); await prepareReleasePreview(project, source.releaseName); }
    else workingPath = resolveProjectPath(project);
    if (source.kind !== 'checkout') await linkCheckoutFiles(project, workingPath);

    const commit = await headShortSha(workingPath).catch(() => undefined);
    const ports = await allocatePorts(this.capacity().portRange || DEFAULT_PORT_RANGE, this.takenPorts());
    const localUrl = `http://127.0.0.1:${ports.client}`;
    const processId = `preview:${previewId}`;

    if (onProgress) onProgress(`Starting ${project.name} on ports ${ports.api} and ${ports.client}`);
    const managed = this.registry.start({
      id: processId, command: entry.startCommand, cwd: workingPath, label: `${project.key} preview (${label})`,
      env: { API_PORT: String(ports.api), CLIENT_PORT: String(ports.client), PORT: String(ports.client), HOST: '127.0.0.1', NODE_ENV: process.env.NODE_ENV || 'development' },
    });

    const readiness = entry.readiness || { ...DEFAULT_READINESS, url: `http://127.0.0.1:\${CLIENT_PORT}/` };
    const readyUrl = fillPorts(readiness.url, ports);
    const outcome = await waitUntilReady(readyUrl, readiness, () => !managed.isRunning());

    if (outcome !== 'ready') {
      const tail = managed.outputTail();
      await this.registry.stop(processId);
      throw new Error(outcome === 'exited'
        ? `${project.name} exited before it was ready (code ${managed.exitCode}):\n${tail}`
        : `${project.name} did not answer at ${readyUrl} within ${readiness.timeoutSeconds} s:\n${tail}`);
    }

    const preview: IServedPreview = { previewId, projectKey: project.key, processId, ports, localUrl, reachableUrl: this.reachableUrlFor(ports), workingPath, commit, startedAt: new Date(), lastTouchedAt: new Date(), isPreview: exclusive };
    this.previews.set(previewId, preview);
    if (options.idles !== false) this.armIdleTimer(preview);

    // The application dying on its own is a stop too
    managed.once('exit', () => {
      if (this.previews.get(previewId)?.processId === processId && managed.state === 'exited') {
        this.forget(previewId);
        this.announce({ previewId, reason: `the application exited with ${managed.exitCode}`, outputTail: managed.outputTail() });
      }
    });

    logger.info(`[preview-serve] ${project.key}: ${label} serving at ${localUrl}${preview.reachableUrl ? ` (reachable at ${preview.reachableUrl})` : ''}`);
    return { processId, ports, localUrl, reachableUrl: preview.reachableUrl, outputTail: managed.outputTail(), commit, workingPath };

  }

  private forget(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview?.idleTimer) clearTimeout(preview.idleTimer);
    this.previews.delete(previewId);
  }

  private announce(payload: IPreviewStoppedPayload): void {
    this.listeners.forEach((listener) => {
      try { listener(payload); } catch (err) { logger.error(`[preview-serve] A stop listener failed: ${(err as Error).message}`); }
    });
  }

  // Stop a served preview; `announce` false when the server asked (it knows)
  async stop(previewId: string, reason: string, announce = true): Promise<boolean> {
    const preview = this.previews.get(previewId);
    if (!preview) return false;
    this.forget(previewId);
    await this.registry.stop(preview.processId);
    logger.info(`[preview-serve] ${preview.projectKey}: stopped ${previewId} (${reason})`);
    if (announce) this.announce({ previewId, reason });
    return true;
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.previews.keys()].map((previewId) => this.stop(previewId, reason)));
  }

}

export const projectCanServe = (project: IRunnerProjectRef): boolean => !!localProjectConfig(project)?.startCommand;
