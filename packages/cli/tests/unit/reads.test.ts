import { describe, it } from 'bun:test';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { registry as generated } from '../../src/generated/commands.ts';
import { renderChange } from '../../src/lib/commands/reads.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { FeedingTransport, fakeWorld, inventoryOf } from './fakes.ts';

const owner = (words: string[]) => {
  const resolved = resolveVerb(buildVerbTable(generated), words);
  return resolved.kind === 'verb' ? resolved.entry.owner : 'unknown';
};

/** Lets the guard's per-frame check (asynchronous) and the verb's own wiring run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  await Bun.sleep(0);
};

const change = (ferret: string, extra: object = {}) => ({ ferret, generation: 3, state: 'working', ...extra });

/** A `fy stream` in flight: its output so far, and the handles a test pulls. */
async function streaming(args: string[], options: { ferretsOn?: boolean } = {}) {
  const transport = new FeedingTransport();
  const interrupt = new AbortController();
  const { world, io } = fakeWorld({
    transport,
    interrupt,
    inventory: inventoryOf({ id: 'ferrets', on: options.ferretsOn ?? true, contract: 'h-ferrets' }),
  });
  const done = runFy(['stream', ...args], world);
  await settle();
  return { transport, interrupt, io, done };
}

describe('the retained read verbs', () => {
  it('V-0058 V-0311 attach and logs are the Terminals and Conversation verbs, so the shell holds no second copy', () => {
    const table = buildVerbTable(generated);
    should(owner(['attach', 'a'])).equal('terminals');
    should(owner(['logs', 'a'])).equal('conversation');
    should(table.conflicts.filter(conflict => ['attach', 'logs'].includes(conflict.line))).deepEqual([]);
  });

  it('V-0442 V-0258 V-0495 snapshot, events and view are not shell verbs, so no copy can shadow their owners', () => {
    for (const verb of ['snapshot', 'events', 'view']) should(owner([verb, 'ada'])).not.equal('shell');
  });
});

describe('fy stream', () => {
  it('V-0452 prints each change of every ferret as the daemon announces it, until interrupted', async () => {
    const { transport, interrupt, io, done } = await streaming([]);
    transport.push('ferrets.changed', change('ada'));
    transport.push('ferrets.changed', change('bo', { gone: true, state: undefined }));
    await settle();
    interrupt.abort();
    should(await done).equal(0);
    should(io.stdout()).equal('ada working (generation 3)\nbo gone (generation 3)\n');
    should(transport.opened).equal(1);
    should(transport.cancelled).equal(1);
  });

  it('V-0452 follows one ferret only when it is named, and prints the event as one JSON line with --json', async () => {
    const { transport, interrupt, io, done } = await streaming(['ada', '--json']);
    transport.push('ferrets.changed', change('bo'));
    transport.push('ferrets.changed', change('ada'));
    await settle();
    interrupt.abort();
    should(await done).equal(0);
    should(
      io
        .stdout()
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).deepEqual([change('ada')]);
  });

  it('V-0452 drops an event whose payload is not the shape its owner declared, and an event nobody follows', async () => {
    const { transport, interrupt, io, done } = await streaming([]);
    transport.push('ferrets.changed', { ferret: 7 });
    transport.push('board.changed', change('ada'));
    await settle();
    interrupt.abort();
    await done;
    should(io.stdout()).equal('');
  });

  it('V-0452 hears nothing while the Ferrets plugin is off: the guard judges every frame like a call', async () => {
    const { transport, interrupt, io, done } = await streaming([], { ferretsOn: false });
    transport.push('ferrets.changed', change('ada'));
    await settle();
    interrupt.abort();
    await done;
    should(io.stdout()).equal('');
  });

  it('V-0452 ends with the feed’s own reason and exit 1 when the daemon goes away', async () => {
    const { transport, io, done } = await streaming([]);
    transport.close('the daemon closed the event feed');
    should(await done).equal(1);
    should(io.stderr()).equal('fy stream: the daemon closed the event feed\n');
  });

  it('V-0452 refuses --after, saying the stream has no sequence to resume from, before it connects', async () => {
    const transport = new FeedingTransport();
    const { world, io, connects } = fakeWorld({ transport });
    should(await runFy(['stream', '--after', '4'], world)).equal(2);
    should(io.stderr()).containEql('has no --after');
    should(connects).deepEqual([]);
    should(transport.opened).equal(0);
  });

  it('V-0452 follows one ferret or all of them, so a second id is refused', async () => {
    const { world, io } = fakeWorld({ transport: new FeedingTransport() });
    should(await runFy(['stream', 'ada', 'bo'], world)).equal(2);
    should(io.stderr()).containEql('fy stream [id]');
  });

  it('V-0452 says a connection that cannot hold a feed open cannot be followed, rather than ending silently', async () => {
    const { world, io } = fakeWorld({ interrupt: new AbortController() });
    const done = runFy(['stream'], world);
    await settle();
    should(await done).equal(1);
    should(io.stderr()).containEql('does not subscribe to events');
  });

  it('V-0452 renders a change by what happened to the ferret', () => {
    should(renderChange({ ferret: 'ada', generation: 1, state: 'idle' })).equal('ada idle (generation 1)');
    should(renderChange({ ferret: 'ada', generation: 2, gone: true })).equal('ada gone (generation 2)');
    should(renderChange({ ferret: 'ada', generation: 2 })).equal('ada changed (generation 2)');
  });

  it('V-0452 FerretsChanged is the owner’s own definition, not a copy', () => {
    should(FerretsChanged.name).equal('ferrets.changed');
  });
});
