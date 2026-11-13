/**
 * `fy agenda <item verb>` through the shell's REAL verb table and the REAL agenda half, over a fake daemon: the
 * sweep found `agenda add`, `done`, `dismiss`, `snooze`, `show`, `ls` and `history` printing the grouped agenda and
 * exiting 0 with nothing raised or closed, because the shell ran the longest known verb (`agenda`) with the rest as
 * arguments. An unknown sub-verb is a usage error that names the verb's real sub-verbs (exit 2), for every verb.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

/** A daemon answering by method and path; every board it serves is empty, as the board of a ferret with nothing open. */
class RoutedTransport extends RecordingTransport {
  constructor(private readonly answers: Record<string, DaemonReply>) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return this.answers[`${request.method} ${request.path}`] ?? { status: 404, body: { error: 'nothing here' } };
  }
}

const EMPTY = {
  v: 1,
  sessionId: 'f1',
  items: [],
  resolved: [],
  count: 0,
  parseErrors: 0,
  updatedAt: '2026-11-13T00:00:00.000Z',
};

const world = (environment: Record<string, string> = { FY_SESSION_ID: 'f1' }) => {
  const transport = new RoutedTransport({
    'GET /v1/ferrets/f1/agenda': { status: 200, body: EMPTY },
    'POST /v1/ferrets/f1/agenda': { status: 200, body: EMPTY },
    'POST /v1/ferrets/f1/agenda/replies': { status: 200, body: EMPTY },
    'GET /v1/agenda/open': { status: 200, body: { sessions: [] } },
  });
  const made = fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
    transport,
    environment,
  });
  const posted = () =>
    transport.sent
      .filter(request => request.method === 'POST' && request.path === '/v1/ferrets/f1/agenda')
      .map(request => request.body as Record<string, unknown>);
  return { ...made, transport, posted };
};

describe('fy agenda item verbs', () => {
  it('agenda add raises the ask on this ferret’s board instead of printing the grouped agenda', async () => {
    const { world: w, io, transport, posted } = world();
    const code = await runFy(
      [
        'agenda',
        'add',
        'Which colour?',
        '--title',
        'Pick a colour',
        '--premise',
        'The badge is plain',
        '--context',
        'It ships Friday',
      ],
      w,
    );
    should(io.stderr()).equal('');
    should(code).equal(0);
    should(posted()).have.length(1);
    should(posted()[0]).containEql({ action: 'add', subject: 'Which colour?' });
    should(transport.sent.map(request => request.path)).not.containEql('/v1/agenda/open');
  });

  it('agenda done closes the item, and answers with the flags v4 had', async () => {
    const { world: w, io, posted } = world();
    should(await runFy(['agenda', 'done', 'A3', '--note', 'shipped'], w)).equal(0);
    should(posted()[0]).containEql({ action: 'resolve', id: 'A3', note: 'shipped' });
    should(io.stderr()).equal('');
    const other = world();
    should(await runFy(['agenda', 'done', '!A4', '--choice', 'Blue'], other.world)).equal(0);
    should(other.posted()[0]).containEql({ action: 'resolve', id: 'A4' });
    should((other.posted()[0] as { response: unknown }).response).containEql({
      kind: 'multiple-choice',
      choice: 'Blue',
    });
  });

  it('agenda dismiss, snooze, unsnooze, surface, rest, step and send-now each reach their route', async () => {
    const run = async (words: string[]) => {
      const w = world();
      const code = await runFy(words, w.world);
      should(w.io.stderr()).equal('');
      should(code).equal(0);
      return w;
    };
    should((await run(['agenda', 'dismiss', 'A3', '--note', 'no longer needed'])).posted()[0]).containEql({
      action: 'dismiss',
      id: 'A3',
    });
    should((await run(['agenda', 'snooze', 'A3', '--for', '4h'])).posted()[0]).containEql({
      action: 'snooze',
      id: 'A3',
    });
    should((await run(['agenda', 'unsnooze', 'A3'])).posted()[0]).containEql({ action: 'unsnooze', id: 'A3' });
    should((await run(['agenda', 'surface', 'A3', '--why', 'still open'])).posted()[0]).containEql({
      action: 'surface',
      id: 'A3',
      why: 'still open',
    });
    should((await run(['agenda', 'rest', 'A3', '--why', 'reading the logs'])).posted()[0]).containEql({
      action: 'rest',
      id: 'A3',
      why: 'reading the logs',
    });
    should((await run(['agenda', 'step', 'A3', '2'])).posted()[0]).containEql({
      action: 'progress',
      id: 'A3',
      step: 1,
      done: true,
    });
    should((await run(['agenda', 'needs-info', 'A3', '--note', 'which file?'])).posted()[0]).containEql({
      action: 'needs-info',
      id: 'A3',
    });
    should((await run(['agenda', 'answer', 'A3', 'It is the second one'])).posted()[0]).containEql({
      action: 'edit',
      id: 'A3',
    });
    // Send now is the owner's: from their own shell, naming the ferret.
    const owner = world({});
    should(await runFy(['agenda', 'send-now', '--session', 'f1'], owner.world)).equal(0);
    should(owner.transport.sent.map(request => request.path)).containEql('/v1/ferrets/f1/agenda/replies');
  });

  it('agenda ls and history read this ferret’s board, not the owner’s roll-up', async () => {
    for (const verb of ['ls', 'history']) {
      const { world: w, transport, io } = world();
      should(await runFy(['agenda', verb], w)).equal(0);
      should(io.stderr()).equal('');
      should(transport.sent.map(request => `${request.method} ${request.path}`)).deepEqual([
        'GET /v1/ferrets/f1/agenda',
      ]);
    }
  });

  it('refuses an item verb with no id by saying how it is written, exit 2, before any daemon call', async () => {
    const { world: w, io, transport } = world();
    should(await runFy(['agenda', 'done'], w)).equal(2);
    should(io.stderr()).containEql('usage: fy agenda done <id>');
    should(transport.sent).deepEqual([]);
  });

  it('acts on the board --session names when this is not a ferret’s pane', async () => {
    const { world: w, posted } = world({});
    should(await runFy(['agenda', 'dismiss', 'A3', '--session', 'f1'], w)).equal(0);
    should(posted()[0]).containEql({ action: 'dismiss', id: 'A3' });
    const none = world({});
    should(await runFy(['agenda', 'dismiss', 'A3'], none.world)).equal(1);
    should(none.io.stderr()).containEql('no session id');
  });
});

describe('an unknown sub-verb under a known verb', () => {
  it('V-0030 is a usage error that names the real sub-verbs, never the parent run with the word as an argument', async () => {
    const { world: w, io, transport } = world();
    should(await runFy(['agenda', 'frobnicate', 'A3'], w)).equal(2);
    should(io.stderr()).containEql('"frobnicate" is not a sub-verb of agenda');
    for (const real of ['agenda add', 'agenda done', 'agenda open', 'agenda clear'])
      should(io.stderr()).containEql(`fy ${real}`);
    should(io.stdout()).equal('');
    should(transport.sent).deepEqual([]);
  });

  it('holds for board import and board lanes, which fell through to the board the same way', async () => {
    for (const words of [
      ['board', 'import'],
      ['board', 'lanes'],
    ]) {
      const { world: w, io } = world();
      should(await runFy(words, w)).equal(2);
      should(io.stderr()).containEql(`"${words[1]}" is not a sub-verb of board`);
      should(io.stderr()).containEql('fy board status');
    }
  });

  it('still runs a parent bare, with only options, and the parents that take their own first word', async () => {
    const { world: w, io } = world({});
    const bare = await runFy(['agenda'], w);
    should(io.stderr()).equal('');
    should(bare).equal(0);
    const flagged = world({});
    const json = await runFy(['agenda', '--json'], flagged.world);
    should(flagged.io.stderr()).equal('');
    should(json).equal(0);
  });
});
