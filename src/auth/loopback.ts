import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NeonError, SignInCancelledError } from '../core/errors';

export interface Loopback {
  redirectUri: string;
  response: Promise<URL>;
  close(): void;
}

export async function startLoopback(
  state: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<Loopback> {
  signal.throwIfAborted();
  let resolve!: (url: URL) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<URL>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void response.catch(() => undefined);
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let redirectUri = '';
  const close = () => {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    server.close();
    server.closeAllConnections();
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
    close();
  };
  const cancel = () => fail(new SignInCancelledError());
  const server = createServer((request, reply) => {
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('Content-Type', 'text/plain; charset=utf-8');
    reply.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    reply.setHeader('X-Content-Type-Options', 'nosniff');
    let url: URL;
    try {
      url = new URL(request.url ?? '/', redirectUri);
    } catch {
      reply.writeHead(400).end('Invalid callback.');
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      reply.writeHead(404).end('Not found.');
      return;
    }
    if (
      url.origin !== new URL(redirectUri).origin ||
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.get('state') !== state
    ) {
      reply
        .writeHead(400)
        .end('Invalid sign-in state. Return to VS Code and try again.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      reply
        .writeHead(400)
        .end('Sign-in was not completed. You can return to VS Code.');
      fail(
        error === 'access_denied'
          ? new SignInCancelledError()
          : new NeonError(
              `Neon rejected the sign-in request (${error}). Check the Neon OAuth client ID setting.`,
            ),
      );
      return;
    }
    if (
      settled ||
      url.searchParams.getAll('code').length !== 1 ||
      !url.searchParams.get('code')
    ) {
      reply.writeHead(400).end('Missing or invalid authorization code.');
      return;
    }
    settled = true;
    reply.end(
      'Authorization received. Return to VS Code to finish signing in.',
    );
    resolve(url);
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    server.close();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', no);
      yes();
    });
  });
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  server.on('error', () =>
    fail(new NeonError('Could not receive the Neon sign-in callback.')),
  );
  signal.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(
    () => fail(new NeonError('Neon sign-in timed out. Please try again.')),
    timeoutMs,
  );
  if (signal.aborted) cancel();
  return {
    redirectUri,
    response,
    close: () => {
      fail(new SignInCancelledError());
      server.closeAllConnections();
    },
  };
}
