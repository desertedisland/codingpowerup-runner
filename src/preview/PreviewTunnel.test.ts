// The tunnel against a real little application: a GET, a POST with a body, a redirect and a
// cookie pass through as frames; a preview this runner does not serve is refused as such.
import { EventEmitter } from 'events';
import http from 'http';
import { AddressInfo } from 'net';
import { ERunnerMessageType, IRunnerEnvelope } from '@yellowmelon/factory-global-types';
import { PreviewTunnel } from './PreviewTunnel';

// A stand-in for the served previews: one preview, served by the application below
const makeServed = (localUrl: string) => {
  const touched: string[] = [];
  return {
    touched,
    get: (previewId: string) => (previewId === 'p1' ? { previewId: 'p1', localUrl } : undefined),
    touch: (previewId: string) => { touched.push(previewId); },
  };
};

// The connection: frames sent by the tunnel are collected; frames "from the server" are emitted
class FakeConnection extends EventEmitter {
  sent: { type: ERunnerMessageType; payload: unknown }[] = [];
  send(type: ERunnerMessageType, payload: unknown): boolean { this.sent.push({ type, payload }); return true; }
  deliver(type: ERunnerMessageType, payload: unknown): void {
    const envelope: IRunnerEnvelope = { id: 'x', type, runnerId: 'r', sentAt: '', protocolVersion: 1, payload };
    this.emit('frame', envelope);
  }
  async next(type: ERunnerMessageType, after = 0): Promise<unknown> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = this.sent.slice(after).find((frame) => frame.type === type);
      if (found) return found.payload;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} frame arrived`);
  }
}

let app: http.Server;
let localUrl: string;

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('Location', `${localUrl}/landed`); res.end(); return; }
    if (req.url === '/cookie') { res.setHeader('Set-Cookie', 'sid=abc; Path=/; Domain=127.0.0.1; HttpOnly'); res.end('cookie set'); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ echoed: body, host: req.headers.host })); });
      return;
    }
    res.setHeader('Content-Type', 'text/plain');
    res.end(`hello ${req.url} from ${req.headers.host}`);
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  localUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => app.close(() => resolve())); });

const decode = (frames: { type: ERunnerMessageType; payload: unknown }[]): string =>
  frames.filter((frame) => frame.type === ERunnerMessageType.PREVIEW_RESPONSE_BODY).map((frame) => Buffer.from((frame.payload as { chunk: string }).chunk, 'base64').toString()).join('');

describe('PreviewTunnel', () => {

  it('relays a GET: the head, then the body in chunks, with the application told its own host', async () => {

    const connection = new FakeConnection();
    const served = makeServed(localUrl);
    const tunnel = new PreviewTunnel(connection, served as never);

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r1', previewId: 'p1', method: 'GET', path: '/page?x=1', headers: { accept: 'text/plain', host: 'p1.preview.example' }, hasBody: false });
    const head = await connection.next(ERunnerMessageType.PREVIEW_RESPONSE) as { status: number; headers: Record<string, string>; hasBody: boolean };
    expect(head.status).toEqual(200);
    expect(head.headers['content-type']).toEqual('text/plain');
    expect(head.hasBody).toBe(true);
    await connection.next(ERunnerMessageType.PREVIEW_RESPONSE_BODY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decode(connection.sent)).toEqual(`hello /page?x=1 from 127.0.0.1:${new URL(localUrl).port}`);
    expect(connection.sent[connection.sent.length - 1].payload).toMatchObject({ last: true });
    expect(served.touched).toEqual(['p1']);
    expect(tunnel.inFlightCount()).toEqual(0);

  });

  it('relays a POST body sent in chunks', async () => {

    const connection = new FakeConnection();
    new PreviewTunnel(connection, makeServed(localUrl) as never);

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r2', previewId: 'p1', method: 'POST', path: '/submit', headers: { 'content-type': 'text/plain' }, hasBody: true });
    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST_BODY, { requestId: 'r2', chunk: Buffer.from('hello ').toString('base64'), last: false });
    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST_BODY, { requestId: 'r2', chunk: Buffer.from('world').toString('base64'), last: true });
    await connection.next(ERunnerMessageType.PREVIEW_RESPONSE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(decode(connection.sent))).toMatchObject({ echoed: 'hello world' });

  });

  it('passes a redirect and a cookie through as the application sent them (the server rewrites)', async () => {

    const connection = new FakeConnection();
    new PreviewTunnel(connection, makeServed(localUrl) as never);

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r3', previewId: 'p1', method: 'GET', path: '/redirect', headers: {}, hasBody: false });
    const redirect = await connection.next(ERunnerMessageType.PREVIEW_RESPONSE) as { status: number; headers: Record<string, string> };
    expect(redirect.status).toEqual(302);
    expect(redirect.headers.location).toEqual(`${localUrl}/landed`);

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r4', previewId: 'p1', method: 'GET', path: '/cookie', headers: {}, hasBody: false });
    const withCookie = await connection.next(ERunnerMessageType.PREVIEW_RESPONSE, connection.sent.length) as { headers: Record<string, string[]> };
    expect(withCookie.headers['set-cookie']).toEqual(['sid=abc; Path=/; Domain=127.0.0.1; HttpOnly']);

  });

  it('refuses a preview it does not serve, and reports an application that cannot be reached', async () => {

    const connection = new FakeConnection();
    new PreviewTunnel(connection, makeServed('http://127.0.0.1:1') as never);

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r5', previewId: 'nope', method: 'GET', path: '/', headers: {}, hasBody: false });
    expect(await connection.next(ERunnerMessageType.PREVIEW_ERROR)).toMatchObject({ requestId: 'r5', notRunning: true });

    connection.deliver(ERunnerMessageType.PREVIEW_REQUEST, { requestId: 'r6', previewId: 'p1', method: 'GET', path: '/', headers: {}, hasBody: false });
    expect(await connection.next(ERunnerMessageType.PREVIEW_ERROR, connection.sent.length) as never).toMatchObject({ requestId: 'r6', message: expect.stringMatching(/could not be reached/) });

  });

});
