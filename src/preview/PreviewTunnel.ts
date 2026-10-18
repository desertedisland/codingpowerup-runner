// The runner's end of the preview relay (step 7): a PREVIEW_REQUEST frame becomes an HTTP request
// to the application this runner serves for that preview; its answer goes back as a
// PREVIEW_RESPONSE frame and PREVIEW_RESPONSE_BODY chunks. Every relayed request counts as the
// preview being used, so it is not idle.
import http from 'http';
import {
  ERunnerMessageType, IPreviewErrorPayload, IPreviewRequestBodyPayload, IPreviewRequestPayload, IPreviewResponseBodyPayload, IPreviewResponsePayload, IRunnerEnvelope,
  TRelayHeaders,
} from '@yellowmelon/factory-global-types';
import logger from '../log/logger';
import { ServedPreviews } from './servePreview';

const CHUNK_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 55 * 1000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// What the tunnel needs of the connection: a way to send frames and a way to hear them
export interface ITunnelConnection {
  send: (type: ERunnerMessageType, payload: unknown) => boolean;
  on: (event: 'frame', listener: (envelope: IRunnerEnvelope) => void) => unknown;
}

interface IInFlight {
  request: http.ClientRequest;
  bodyEnded: boolean;
}

export class PreviewTunnel {

  private readonly inFlight = new Map<string, IInFlight>();

  constructor(private readonly connection: ITunnelConnection, private readonly served: ServedPreviews) {
    connection.on('frame', (envelope) => this.onFrame(envelope));
  }

  private onFrame(envelope: IRunnerEnvelope): void {
    switch (envelope.type) {
      case ERunnerMessageType.PREVIEW_REQUEST: this.open(envelope.payload as IPreviewRequestPayload); return;
      case ERunnerMessageType.PREVIEW_REQUEST_BODY: this.body(envelope.payload as IPreviewRequestBodyPayload & { aborted?: boolean }); return;
      default: return;
    }
  }

  private fail(requestId: string, message: string, notRunning = false): void {
    const payload: IPreviewErrorPayload = { requestId, message, notRunning };
    this.connection.send(ERunnerMessageType.PREVIEW_ERROR, payload);
    const inFlight = this.inFlight.get(requestId);
    if (inFlight) { inFlight.request.destroy(); this.inFlight.delete(requestId); }
  }

  private open(frame: IPreviewRequestPayload): void {

    const preview = this.served.get(frame.previewId);
    if (!preview) { this.fail(frame.requestId, 'This preview is not served by this runner', true); return; }
    this.served.touch(frame.previewId);

    const target = new URL(frame.path, preview.localUrl);
    const headers: http.OutgoingHttpHeaders = {};
    Object.entries(frame.headers || {}).forEach(([name, value]) => { if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value; });
    headers.host = target.host;

    const request = http.request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: frame.method, headers, timeout: REQUEST_TIMEOUT_MS }, (response) => {

      const responseHeaders: TRelayHeaders = {};
      Object.entries(response.headers).forEach(([name, value]) => { if (value !== undefined && !HOP_BY_HOP.has(name)) responseHeaders[name] = value; });
      const hasBody = !(frame.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304);
      const head: IPreviewResponsePayload = { requestId: frame.requestId, status: response.statusCode || 502, headers: responseHeaders, hasBody };
      this.connection.send(ERunnerMessageType.PREVIEW_RESPONSE, head);

      if (!hasBody) { response.resume(); this.inFlight.delete(frame.requestId); return; }

      response.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
          const payload: IPreviewResponseBodyPayload = { requestId: frame.requestId, chunk: chunk.subarray(offset, offset + CHUNK_BYTES).toString('base64'), last: false };
          this.connection.send(ERunnerMessageType.PREVIEW_RESPONSE_BODY, payload);
        }
      });
      response.on('end', () => {
        const payload: IPreviewResponseBodyPayload = { requestId: frame.requestId, chunk: '', last: true };
        this.connection.send(ERunnerMessageType.PREVIEW_RESPONSE_BODY, payload);
        this.inFlight.delete(frame.requestId);
      });
      response.on('error', (err) => this.fail(frame.requestId, `The application's response failed: ${err.message}`));

    });

    request.on('timeout', () => this.fail(frame.requestId, 'The application did not answer in time'));
    request.on('error', (err) => {
      if (this.inFlight.has(frame.requestId)) this.fail(frame.requestId, `The application could not be reached: ${err.message}`);
    });

    this.inFlight.set(frame.requestId, { request, bodyEnded: false });
    if (!frame.hasBody) request.end();
    logger.debug(`[preview-tunnel] ${frame.method} ${target.pathname} for ${frame.previewId}`);

  }

  private body(frame: IPreviewRequestBodyPayload & { aborted?: boolean }): void {
    const inFlight = this.inFlight.get(frame.requestId);
    if (!inFlight || inFlight.bodyEnded) return;
    if (frame.aborted) { inFlight.request.destroy(); this.inFlight.delete(frame.requestId); return; }
    if (frame.chunk) inFlight.request.write(Buffer.from(frame.chunk, 'base64'));
    if (frame.last) { inFlight.bodyEnded = true; inFlight.request.end(); }
  }

  inFlightCount(): number { return this.inFlight.size; }

}
