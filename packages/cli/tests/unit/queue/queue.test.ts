import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import type { z } from 'zod';
import { registerQueueCommands } from '../../../src/lib/queue/commands';
import { ProtocolQueueGateway, queuePath } from '../../../src/lib/queue/gateway';
import type { IQueueGateway, QueueApiClient } from '../../../src/lib/queue/ports';
import { renderQueue } from '../../../src/lib/queue/render';

const AT = '2026-10-30T13:05:37.000Z';

function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    v: 1,
    id: 'q-1',
    sender: 'human',
    text: 'ship it',
    attachmentIds: [],
    enqueuedAt: AT,
    state: 'queued',
    stateAt: AT,
    revision: 1,
    ...overrides,
  };
}

class Gateway implements IQueueGateway {
  readonly asked: string[] = [];
  constructor(private readonly held: readonly QueuedMessage[]) {}

  async messages(ferret: string): Promise<readonly QueuedMessage[]> {
    this.asked.push(ferret);
    return this.held;
  }
}

function run(argv: string[], held: readonly QueuedMessage[]) {
  const lines: string[] = [];
  const gateway = new Gateway(held);
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerQueueCommands(program, { gateway, out: { report: line => void lines.push(line) } });
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, lines };
}

describe('fy queue', () => {
  it("should list the ferret's queue, one line per message, asking by the name it was given", async () => {
    const { parsed, gateway, lines } = run(['queue', 'lizzette'], [message(), message({ id: 'q-2', state: 'read' })]);
    await parsed;

    should(gateway.asked).eql(['lizzette']);
    should(lines).eql(['✓  q-1  you: ship it', '✓✓✓  q-2  you: ship it']);
  });

  it('should print the protocol payload with --json', async () => {
    const { parsed, lines } = run(['queue', 'lizzette', '--json'], [message()]);
    await parsed;

    should(JSON.parse(lines.join('\n'))).deepEqual({ messages: [message()] });
  });
});

describe('a queue as lines', () => {
  it('should say so when nothing is queued', () => {
    should(renderQueue([])).eql(['Nothing queued.']);
  });

  it('should say why a waiting message waits, and why a failed one failed', () => {
    should(renderQueue([message({ waitReason: 'draft' })])).eql([
      '✓  q-1  you: ship it — waiting: its box holds a draft',
    ]);
    should(renderQueue([message({ state: 'failed', failure: 'the session ended' })])).eql([
      '✗ failed  q-1  you: ship it — the session ended',
    ]);
    should(renderQueue([message({ state: 'failed' })])).eql(['✗ failed  q-1  you: ship it']);
    // A reason is only shown while the message waits.
    should(renderQueue([message({ state: 'typing', waitReason: 'busy' })])).eql(['✓ typing  q-1  you: ship it']);
  });

  it("should name a ferret's message by its sender, the daemon's as Ferretry, and flatten and clip long words", () => {
    const long = `first line\n\n${'word '.repeat(30)}`;

    should(renderQueue([message({ sender: 'agent', fromName: 'denisha' })])[0]).equal('✓  q-1  denisha: ship it');
    should(renderQueue([message({ sender: 'agent' })])[0]).equal('✓  q-1  ferret: ship it');
    should(renderQueue([message({ sender: 'daemon', state: 'cancelled' })])[0]).equal(
      '✗ cancelled  q-1  Ferretry: ship it',
    );
    const clipped = renderQueue([message({ text: long })])[0] as string;
    should(clipped).startWith('✓  q-1  you: first line word word');
    should(clipped).endWith('…');
    should(clipped.length).equal('✓  q-1  you: '.length + 60);
  });
});

describe('the queue route', () => {
  it('should escape the ferret it addresses, and parse what the daemon answers', async () => {
    const paths: string[] = [];
    const client: QueueApiClient = {
      request: <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
        paths.push(path);
        return Promise.resolve(schema.parse({ messages: [message({ state: 'delivered' })] }));
      },
    };

    const messages = await new ProtocolQueueGateway(client).messages('a/b');

    should(queuePath('lizzette')).equal('/v1/sessions/lizzette/queue');
    should(paths).eql(['/v1/sessions/a%2Fb/queue']);
    should(messages.map(entry => entry.state)).eql(['delivered']);
  });
});
