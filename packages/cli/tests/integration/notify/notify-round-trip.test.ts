import { afterEach, describe, it } from 'bun:test';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import type { z } from 'zod';
import { registerNotifyCommands } from '../../../src/lib/notify/commands';
import { ProtocolNotifyGateway } from '../../../src/lib/notify/gateway';
import type { NotifyApiClient } from '../../../src/lib/notify/ports';
import { Command } from 'commander';
import { snapshot } from '../../unit/attention/fixtures';
import { CapturingOutput, SESSION } from '../../unit/notify/fixtures';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A real HTTP server on an EPHEMERAL loopback port that records each request and answers as told. */
function daemon(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const text = await request.text();
      const entry: Seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: text === '' ? undefined : JSON.parse(text),
      };
      seen.push(entry);
      return answer(entry);
    },
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${String(server.port)}` };
}

async function run(url: string, argv: string[]) {
  const connected = await FyApiClient.connect({ baseUrl: url, token: 'test-token', version: '1.2.3' });
  const client: NotifyApiClient = {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> =>
      connected.request(path, schema, init),
  };
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  registerNotifyCommands(program, { gateway: new ProtocolNotifyGateway(client, SESSION), out, ownSessionId: SESSION });
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), out };
}

describe('fy notify against a daemon', () => {
  it('should raise a ping notice over the wire with the ferret named in the headers', async () => {
    // Arrange
    const { seen, url } = daemon(() => Response.json(snapshot([])));

    // Act
    const { parsed, out } = await run(url, ['notify', 'Disk is full', '--ping']);
    await parsed;

    // Assert
    should(seen[0]?.method).equal('POST');
    should(seen[0]?.path).equal(`/v1/sessions/${SESSION}/attention`);
    should(seen[0]?.headers['x-ferretry-session-id']).equal(SESSION);
    should(seen[0]?.body).have.properties({ action: 'add', notice: true, ping: true, subject: 'Disk is full' });
    should(out.messages[0]).containEql('their phone buzzes');
  });

  it('should word the daemon’s refusal and print no success', async () => {
    // Arrange
    const { url } = daemon(() => Response.json({ error: 'this session is not yours to notify for' }, { status: 403 }));

    // Act
    const { parsed, out } = await run(url, ['notify', 'hello']);

    // Assert
    await should(parsed).be.rejectedWith(/not yours to notify for/u);
    should(out.messages).be.empty();
  });

  it('should switch agenda mode over PATCH and print the daemon’s note', async () => {
    // Arrange
    const { seen, url } = daemon(() =>
      Response.json({ enabled: true, restartRequired: true, note: 'Takes effect at its next launch.' }),
    );

    // Act
    const { parsed, out } = await run(url, ['notify', 'agenda', 'on']);
    await parsed;

    // Assert
    should(seen[0]?.method).equal('PATCH');
    should(seen[0]?.path).equal(`/v1/sessions/${SESSION}/agenda-mode`);
    should(seen[0]?.body).deepEqual({ enabled: true });
    should(out.messages).deepEqual(['Agenda mode is now on. Takes effect at its next launch.']);
  });
});
