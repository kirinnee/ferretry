#!/usr/bin/env bun

function fail(message: string): never {
  process.stderr.write(`fake-daemon: ${message}\n`);
  process.exit(1);
}

const portText = process.env.FY_E2E_WS_PORT;
if (portText === undefined || !/^[0-9]+$/.test(portText)) {
  fail('FY_E2E_WS_PORT must be an integer port');
}

const port = Number.parseInt(portText, 10);
if (port < 1024 || port > 65535) {
  fail('FY_E2E_WS_PORT must be an unprivileged port from 1024 through 65535');
}

const daemonEvent = process.env.FY_E2E_DAEMON_EVENT;
if (daemonEvent === undefined) {
  fail('FY_E2E_DAEMON_EVENT is required');
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return new Response('ok\n', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (request.method === 'GET' && (url.pathname === '/events' || url.pathname === '/v1/events')) {
        if (bunServer.upgrade(request, { data: undefined })) {
          return undefined;
        }
        return new Response('WebSocket upgrade required\n', { status: 426 });
      }
      return new Response('Not found\n', { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(daemonEvent);
      },
      message() {
        // This stub is output-only; incoming messages are deliberately ignored.
      },
    },
  });
} catch {
  fail('could not bind the loopback server');
}

let stopping = false;
const stop = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  void server.stop(true);
  process.exit(0);
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
