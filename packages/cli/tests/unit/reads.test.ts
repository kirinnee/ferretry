import { describe, it } from 'bun:test';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import should from 'should';
import { registry as generated } from '../../src/generated/commands.ts';
import { EVENTS_ROUTE, renderEvent, SNAPSHOT_ROUTE } from '../../src/lib/commands/reads.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { fakeWorld, inventoryOf, registryOf, skeletonEntry } from './fakes.ts';

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;

/** The two owners as they will declare the routes: Ferrets the journal, Terminals the screen. */
const owners = () =>
  registryOf(
    skeletonEntry(
      definePlugin({
        id: 'ferrets',
        title: 'Ferrets',
        version: '5.0.0',
        api: 5,
        core: true,
        kinds: [],
        actions: { routes: [route(EVENTS_ROUTE, { ...SCOPE, caller: 'any' })] },
      }),
      'h-ferrets',
    ),
    skeletonEntry(
      definePlugin({
        id: 'terminals',
        title: 'Terminals',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: ['command'],
        actions: { routes: [route(SNAPSHOT_ROUTE, { ...SCOPE, caller: 'any' })] },
      }),
      'h-terminals',
    ),
  );

const inventory = () => inventoryOf({ id: 'terminals', contract: 'h-terminals' });

const event = (sequence: number, extra: object = {}) => ({
  sequence,
  time: '2026-11-07T01:02:03.000Z',
  type: 'turn.started',
  source: 'daemon',
  ...extra,
});

describe('the retained read verbs', () => {
  it('V-0058 V-0311 attach and logs are the Terminals and Conversation verbs, so the shell holds no second copy', () => {
    const table = buildVerbTable(generated);
    const owner = (words: string[]) => {
      const resolved = resolveVerb(table, words);
      return resolved.kind === 'verb' ? resolved.entry.owner : 'unknown';
    };
    should(owner(['attach', 'a'])).equal('terminals');
    should(owner(['logs', 'a'])).equal('conversation');
    should(table.conflicts.filter(conflict => ['attach', 'logs'].includes(conflict.line))).deepEqual([]);
  });

  it('V-0442 should print the live screen of a ferret, asking the daemon for the live one', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 200, body: 'line one\nline two' });
    should(await runFy(['snapshot', 'ada'], world)).equal(0);
    should(io.stdout()).equal('line one\nline two\n');
    should(transport.sent[0]?.path).equal('/v1/ferrets/ada/snapshot?live=true');
  });

  it('V-0442 should print the screen as one JSON line with --json', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 200, body: 'hi\n' });
    should(await runFy(['snapshot', 'ada', '--json'], world)).equal(0);
    should(JSON.parse(io.stdout())).deepEqual({ ferretId: 'ada', snapshot: 'hi\n' });
  });

  it('V-0442 should say a dead pane was refused, and exit 1, rather than print a blank screen', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 409, body: { error: 'the pane of ada is dead' } });
    should(await runFy(['snapshot', 'ada'], world)).equal(1);
    should(io.stderr()).containEql('the pane of ada is dead');
    should(io.stdout()).equal('');
  });

  it('V-0442 V-0258 should name the ferret when none is given', async () => {
    const { world, io } = fakeWorld({ registry: owners(), inventory: inventory() });
    should(await runFy(['snapshot'], world)).equal(2);
    should(await runFy(['events'], world)).equal(2);
    should(io.stderr()).containEql('name the ferret: fy snapshot <id>');
    should(io.stderr()).containEql('name the ferret: fy events <id>');
  });

  it('V-0258 should print each recorded event on a line led by its sequence, the turn only when recorded', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({
      status: 200,
      body: [event(1), event(2, { turn: 3, data: { a: 1 } })],
    });
    should(await runFy(['events', 'ada'], world)).equal(0);
    should(io.stdout()).equal(
      '#1 2026-11-07T01:02:03.000Z turn.started (daemon)\n#2 2026-11-07T01:02:03.000Z turn.started turn=3 (daemon) {"a":1}\n',
    );
    should(transport.sent[0]?.path).equal('/v1/ferrets/ada/events?after=0&limit=1000');
  });

  it('V-0258 should print one protocol event per line with --json, from --after, at most --limit', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 200, body: [event(8), event(9)] });
    should(await runFy(['events', 'ada', '--after', '7', '--limit', '2', '--json'], world)).equal(0);
    should(
      io
        .stdout()
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { sequence: number }).sequence),
    ).deepEqual([8, 9]);
    should(transport.sent[0]?.path).equal('/v1/ferrets/ada/events?after=7&limit=2');
  });

  it('V-0258 should read page after page, from the last sequence, until a short page ends it', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    const full = Array.from({ length: 1000 }, (_, index) => event(index + 1));
    transport.replies.push({ status: 200, body: full }, { status: 200, body: [event(1001)] });
    should(await runFy(['events', 'ada'], world)).equal(0);
    should(io.stdout().trim().split('\n').length).equal(1001);
    should(transport.sent.map(request => request.path)).deepEqual([
      '/v1/ferrets/ada/events?after=0&limit=1000',
      '/v1/ferrets/ada/events?after=1000&limit=1000',
    ]);
  });

  it('V-0258 should refuse a page that does not move the cursor instead of looping', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 200, body: Array.from({ length: 1000 }, () => event(0)) });
    should(await runFy(['events', 'ada'], world)).equal(1);
    should(io.stderr()).containEql('did not advance its cursor');
  });

  it('V-0258 should refuse a cursor or a limit that is not a whole number before asking the daemon', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    should(await runFy(['events', 'ada', '--after=-1'], world)).equal(2);
    should(await runFy(['events', 'ada', '--limit', '0'], world)).equal(2);
    should(await runFy(['events', 'ada', '--limit', 'x'], world)).equal(2);
    should(io.stderr()).containEql('--after must be a non-negative integer');
    should(io.stderr()).containEql('--limit must be a positive integer');
    should(transport.sent).deepEqual([]);
  });

  it('V-0495 should answer fy view exactly as fy events', async () => {
    const { world, io, transport } = fakeWorld({ registry: owners(), inventory: inventory() });
    transport.replies.push({ status: 200, body: [event(5)] });
    should(await runFy(['view', 'ada'], world)).equal(0);
    should(io.stdout()).containEql('#5 ');
  });

  it('V-0258 should say no plugin declares the route, and send nothing, until its owner declares it', async () => {
    const { world, io, transport } = fakeWorld({ registry: registryOf(), inventory: inventoryOf() });
    should(await runFy(['events', 'ada'], world)).equal(1);
    should(io.stderr()).containEql(`no plugin declares the route ${EVENTS_ROUTE}`);
    should(transport.sent).deepEqual([]);
  });

  it('V-0258 renders a turn only when the producer recorded one', () => {
    should(renderEvent({ ...event(4), data: null })).equal('#4 2026-11-07T01:02:03.000Z turn.started (daemon)');
  });
});
