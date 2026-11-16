import { afterEach } from 'bun:test';

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A loopback stand-in for the daemon that records every request and answers as told. Stopped after each test. */
export function standInDaemon(answer: (request: Request, path: string) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.clone().text(),
      });
      return await answer(request, url.pathname);
    },
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${String(server.port)}`, port: server.port as number, server };
}

export const HEALTH = { protocol: 1, version: '5.0.0' } as const;
