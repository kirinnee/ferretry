import { describe, it } from 'bun:test';
import should from 'should';
import { FERRET, terminalsHalf } from '../../support/daemon/half.ts';

/**
 * The relay row Terminals enforces, on the whole daemon half (the kernel's test host) through the REAL stream route
 * and the real stream bridge: the terminal stream is one socket, so when the carrier drops it the work stays with the
 * daemon and nothing the viewer had in flight is typed a second time.
 */

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Lets the bridge's serial write chain (an act per frame) run to the end. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
};

async function opened() {
  const half = await terminalsHalf();
  const open = await half.host.tool('terminal_open', { name: 'dev' });
  should(open.isError).not.equal(true);
  half.as('owner');
  const [record] = half.runtime.records;
  const id = record?.id ?? '';
  return { half, id, path: `/v1/ferrets/${FERRET}/terminals/${id}/stream` };
}

describe('the terminal stream rows', () => {
  it('R141 a dropped carrier loses the stream but not the terminal, and input in flight is never replayed on the new attach', async () => {
    // Arrange — a viewer attached over the stream route, and what it typed has reached the pane.
    const { half, id, path } = await opened();
    half.runtime.screens.set(id, '$ ls');
    const first = await half.host.socket(path);
    should(first.response).be.undefined();
    first.handler?.fromClient(text('ls\r'));
    await half.host.settle();
    await flush();
    should(half.runtime.typed.map(entry => entry.text)).deepEqual(['ls\r']);

    // Act — the relay drops the carrier. Anything the old stream's client says after that is a closed stream's: dropped.
    first.handler?.close({ code: 1006, reason: 'relay outage' });
    first.handler?.fromClient(text('late\r'));
    await half.host.settle();
    await flush();
    // The viewer's carrier returns and it attaches again.
    const second = await half.host.socket(path);
    await half.host.settle();
    await flush();

    // Assert — the terminal itself survived the outage (the daemon holds the work, the relay held none)...
    const listed = await half.host.request('GET', `/v1/ferrets/${FERRET}/terminals`);
    should(listed.status).equal(200);
    should(JSON.stringify(listed.body)).containEql(id);
    // ...the new attach is a REDRAW of the screen, not a replay of what was typed...
    should(second.response).be.undefined();
    should(second.frames.length).be.greaterThan(0);
    should(second.frames.every(frame => frame instanceof Uint8Array)).be.true();
    // ...and the pane was typed exactly once: neither the old input nor the late frame reached it again.
    should(half.runtime.typed.map(entry => entry.text)).deepEqual(['ls\r']);
  });
});
