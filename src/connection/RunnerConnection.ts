// The runner's side of the socket: dial the control plane, register with the credential, keep
// the heartbeat going, reconnect with backoff when the line drops, and stop for good when told
// the runner is revoked or too old. Frames other than the protocol's housekeeping are handed to
// whoever is listening (the job dispatcher, from step 4).
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  ERunnerMessageType, IRunnerCapabilities, IRunnerEnvelope, IRunnerErrorPayload, IRunnerHeartbeatPayload, IRunnerProjectPresence, IRunnerRegisteredPayload,
  IRunnerRegisterPayload, IRunnerRevokedPayload, RUNNER_CLOSE_CODES, RUNNER_PROTOCOL_VERSION,
} from '@yellowmelon/factory-global-types';

export const RUNNER_SOCKET_PATH = '/runner/ws';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;

export interface IRunnerConnectionOptions {
  serverUrl: string;      // the API origin, http(s)://...
  credential: string;
  runnerId: string;
  version: string;
  platform: string;
  hostname?: string;
  capabilities: () => Promise<IRunnerCapabilities>;
  projects: () => Promise<IRunnerProjectPresence[]>;
  activeJobs?: () => string[];
  log?: (line: string) => void;
}

export type TConnectionState = 'connecting' | 'online' | 'offline' | 'stopped';

// "https://devapi.yellowmelon.co" -> "wss://devapi.yellowmelon.co/runner/ws"
export const socketUrlFor = (serverUrl: string): string => {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}${RUNNER_SOCKET_PATH}`;
  url.search = '';
  return url.toString();
};

export class RunnerConnection extends EventEmitter {

  state: TConnectionState = 'offline';
  registered: IRunnerRegisteredPayload | null = null;
  stopReason: string | null = null;

  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopped = false;

  constructor(private readonly options: IRunnerConnectionOptions) {
    super();
  }

  private log(line: string): void {
    if (this.options.log) this.options.log(line);
  }

  start(): void {
    this.stopped = false;
    this.stopReason = null;
    this.connect();
  }

  // Stop for good: no reconnect
  stop(reason = 'stopped'): void {
    this.stopped = true;
    this.stopReason = reason;
    this.clearTimers();
    if (this.socket) { this.socket.close(1000, reason); this.socket = null; }
    this.setState('stopped');
  }

  isOnline(): boolean {
    return this.state === 'online' && !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  send(type: ERunnerMessageType, payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const envelope: IRunnerEnvelope = { id: randomUUID(), type, runnerId: this.options.runnerId, sentAt: new Date().toISOString(), protocolVersion: RUNNER_PROTOCOL_VERSION, payload };
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  // Tell the server what the machine has now (after a checkout appeared, say)
  async reportStatus(): Promise<void> {
    if (!this.isOnline()) return;
    this.send(ERunnerMessageType.STATUS, { capabilities: await this.options.capabilities(), projects: await this.options.projects(), activeJobs: this.options.activeJobs ? this.options.activeJobs() : [] });
  }

  private setState(state: TConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private clearTimers(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private connect(): void {

    if (this.stopped) return;
    this.setState('connecting');
    const url = socketUrlFor(this.options.serverUrl);
    this.log(`Connecting to ${url}`);

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', async () => {
      try {
        const payload: IRunnerRegisterPayload = {
          credential: this.options.credential,
          version: this.options.version,
          platform: this.options.platform,
          hostname: this.options.hostname,
          capabilities: await this.options.capabilities(),
          projects: await this.options.projects(),
        };
        this.send(ERunnerMessageType.REGISTER, payload);
      } catch (err) {
        this.log(`Could not register: ${(err as Error).message}`);
        socket.close(1011, 'register failed');
      }
    });

    socket.on('message', (raw) => this.handle(raw.toString()));

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.registered = null;
      this.handleClose(code, reason.toString());
    });

    socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
    });

  }

  private handle(raw: string): void {

    let envelope: IRunnerEnvelope;
    try {
      envelope = JSON.parse(raw) as IRunnerEnvelope;
    } catch {
      this.log('Ignoring a frame that is not JSON');
      return;
    }

    switch (envelope.type) {
      case ERunnerMessageType.REGISTERED: {
        this.registered = envelope.payload as IRunnerRegisteredPayload;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.setState('online');
        this.log(`Online as "${this.registered.name}" (${this.registered.runnerId}); heartbeat every ${this.registered.heartbeatIntervalMs} ms`);
        this.startHeartbeat(this.registered.heartbeatIntervalMs);
        this.emit('registered', this.registered);
        return;
      }
      case ERunnerMessageType.REQUEST_STATUS:
        this.reportStatus().catch((err) => this.log(`Could not report status: ${err.message}`));
        return;
      case ERunnerMessageType.REVOKED: {
        const payload = envelope.payload as IRunnerRevokedPayload;
        this.log(`Revoked by the server: ${payload?.reason || 'no reason given'}`);
        this.stop(`revoked: ${payload?.reason || 'no reason given'}`);
        this.emit('revoked', payload);
        return;
      }
      case ERunnerMessageType.ERROR: {
        const payload = envelope.payload as IRunnerErrorPayload;
        this.log(`Server says: ${payload?.code} ${payload?.message}`);
        this.emit('serverError', payload);
        return;
      }
      default:
        this.emit('frame', envelope);
    }

  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Twice as often as the server needs, so one lost frame costs nothing
    this.heartbeat = setInterval(() => {
      const payload: IRunnerHeartbeatPayload = { activeJobs: this.options.activeJobs ? this.options.activeJobs() : [] };
      this.send(ERunnerMessageType.HEARTBEAT, payload);
    }, Math.max(1000, Math.floor(intervalMs / 2)));
  }

  // Some closes mean "stop": the credential is dead, or the runner is too old. The rest are a
  // dropped line, to be dialled again with backoff.
  private handleClose(code: number, reason: string): void {

    if (this.stopped) return;

    if (code === RUNNER_CLOSE_CODES.REVOKED || code === RUNNER_CLOSE_CODES.UNAUTHENTICATED) {
      this.log(`The server refused this runner's credential (${code} ${reason}). Pair again with: codingpowerup-runner connect`);
      this.stop(`credential refused: ${reason}`);
      return;
    }
    if (code === RUNNER_CLOSE_CODES.PROTOCOL_VERSION) {
      this.log(`This runner is too old for the server (${reason}). Update it: npm install -g @codingpowerup/runner`);
      this.stop(`too old: ${reason}`);
      return;
    }
    if (code === RUNNER_CLOSE_CODES.REPLACED) {
      this.log('Another instance of this runner connected; this one stops.');
      this.stop('replaced by another instance');
      return;
    }

    this.setState('offline');
    this.log(`Disconnected (${code}${reason ? ` ${reason}` : ''}); reconnecting in ${Math.round(this.backoffMs / 1000)} s`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);

  }

}
