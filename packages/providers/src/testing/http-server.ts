import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export type FakeHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  socket: Socket,
) => void | Promise<void>;

export interface FakeServer {
  /** Origin with no trailing slash, e.g. http://127.0.0.1:53211 */
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  /** Sockets the server currently has open. */
  openSockets(): number;
  /** Resolves once every server-side socket has closed; rejects after `timeoutMs`. */
  waitForNoSockets(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * A scripted HTTP server on 127.0.0.1 for transport and conformance tests. The handler sees the
 * fully read request body. Tracking sockets lets tests prove that aborts and cancels never leave a
 * connection dangling.
 */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: RecordedRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      void Promise.resolve(handler(request, response, incoming.socket)).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  const { port } = address satisfies AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    openSockets: () => sockets.size,
    async waitForNoSockets(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (sockets.size > 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `${String(sockets.size)} socket(s) still open after ${String(timeoutMs)} ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  };
}
