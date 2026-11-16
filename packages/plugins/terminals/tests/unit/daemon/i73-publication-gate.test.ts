import { describe, it } from 'bun:test';
import { HoldsChanged, targetRef } from '@ferretry/core-vault/contract';
import should from 'should';
import { FERRET, terminalsHalf } from '../../support/daemon/half.ts';

/**
 * Row I73 at TERMINALS' OWN publication points, on the whole daemon half through the REAL stream route and bridge:
 * a quarantine that began after the pane was read (so after the read was stamped) withholds every frame kind, and the
 * frame the bridge records as "what the viewer shows" is the notice, never the screen. Vault proves the same row at
 * the kernel Dispatcher's gate (`read-scope.test.ts`); this is the half that belongs to whoever draws the stream.
 */

const PANE = targetRef('terminal', '%1');
/** Not the vault's value, so only the hold (never the masking) can keep it from the viewer. */
const LEAK = 'Password: not-in-the-vault-7731';
const SAFE = ['$ ls', '', '', '', ''].join('\n');
const SECRET = [LEAK, '', '', '', ''].join('\n');

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
  const path = `/v1/ferrets/${FERRET}/terminals/${id}/stream`;
  /** The hold begins while the pane is being read: the read was stamped before it. */
  const quarantineDuringNextRead = (): void => {
    half.runtime.onCapture = () => {
      half.runtime.onCapture = undefined;
      half.holds.quarantine(PANE);
      generation += 1;
      half.host.emit(HoldsChanged, { target: PANE, generation });
    };
  };
  /** The owner ends the hold: the Vault clears it and says the generation moved. */
  const endHold = (): void => {
    half.holds.clear(PANE);
    generation += 1;
    half.host.emit(HoldsChanged, { target: PANE, generation });
  };
  /** One poll of the stream: the driven clock reaches the bridge's timer. */
  const poll = async (): Promise<void> => {
    await half.host.clock.advance(1_000);
    await flush();
  };
  let generation = 0;
  return { half, id, path, quarantineDuringNextRead, endHold, poll };
}

const shown = (frames: readonly (string | Uint8Array)[]): string =>
  frames.map(frame => (typeof frame === 'string' ? frame : new TextDecoder().decode(frame))).join('');

describe('row I73 at the terminal stream', () => {
  it('I73 a complete redraw read before a quarantine began is withheld: the viewer is shown the notice', async () => {
    // Arrange
    const t = await opened();
    t.half.runtime.screens.set(t.id, SECRET);
    t.quarantineDuringNextRead();

    // Act
    const socket = await t.half.host.socket(t.path);
    await flush();

    // Assert
    should(socket.response).be.undefined();
    should(shown(socket.frames)).not.containEql(LEAK);
    should(shown(socket.frames)).containEql('Kept from view');
  });

  it('I73 a delta read before a quarantine began is withheld: the viewer is shown the notice', async () => {
    // Arrange — the viewer's size matches the pane's, so the next frame is a delta, not a redraw.
    const t = await opened();
    t.half.runtime.screens.set(t.id, SAFE);
    const socket = await t.half.host.socket(t.path);
    socket.handler?.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await flush();
    await t.poll();
    const before = socket.frames.length;
    t.half.runtime.screens.set(t.id, SECRET);
    t.quarantineDuringNextRead();

    // Act
    await t.poll();

    // Assert
    should(socket.frames.length).be.greaterThan(before);
    should(shown(socket.frames)).not.containEql(LEAK);
    should(shown(socket.frames.slice(before))).containEql('Kept from view');
  });

  it('I73 a re-attach read before a quarantine began is withheld: the new viewer is shown the notice', async () => {
    // Arrange — one viewer is already attached; the pane changes and the hold begins as the next one reads it.
    const t = await opened();
    t.half.runtime.screens.set(t.id, SAFE);
    await t.half.host.socket(t.path);
    t.half.runtime.screens.set(t.id, SECRET);
    t.quarantineDuringNextRead();

    // Act
    const again = await t.half.host.socket(t.path);
    await flush();

    // Assert
    should(shown(again.frames)).not.containEql(LEAK);
    should(shown(again.frames)).containEql('Kept from view');
  });

  it('I73 the second capture of a complete redraw is withheld too, whichever read the hold began after', async () => {
    // Arrange — a viewer that never said its size: its next poll is a complete redraw, which reads the pane a second time.
    const t = await opened();
    t.half.runtime.screens.set(t.id, SAFE);
    const socket = await t.half.host.socket(t.path);
    await flush();
    t.half.runtime.screens.set(t.id, SECRET);
    let reads = 0;
    t.half.runtime.onCapture = () => {
      reads += 1;
      if (reads === 2) {
        t.half.runtime.onCapture = undefined;
        t.half.holds.quarantine(PANE);
        t.half.host.emit(HoldsChanged, { target: PANE, generation: 1 });
      }
    };

    // Act
    await t.poll();

    // Assert — the poll's window read was fine when taken; the redraw's own read was stamped before the hold.
    should(reads).be.greaterThanOrEqual(2);
    should(shown(socket.frames)).not.containEql(LEAK);
    should(shown(socket.frames)).containEql('Kept from view');
  });

  it('I73 the last frame the bridge records is the notice, never the screen: the hold ending redraws the pane', async () => {
    // Arrange — the first read of the viewer was stamped before the hold: it is shown the notice.
    const t = await opened();
    t.half.runtime.screens.set(t.id, SECRET);
    t.quarantineDuringNextRead();
    const socket = await t.half.host.socket(t.path);
    await flush();
    should(socket.frames.length).be.greaterThan(0);

    // Act — more polls while the hold lasts, then the owner ends it.
    await t.poll();
    await t.poll();
    const during = socket.frames.length;
    t.endHold();
    await t.poll();

    // Assert — nothing drawn under the hold carries the screen. Had the withheld screen been recorded as what the
    // viewer shows, the pane would read as "unchanged" when the hold ended and the viewer would stay on the notice.
    should(shown(socket.frames.slice(0, during))).not.containEql(LEAK);
    should(shown(socket.frames.slice(during))).containEql(LEAK);
  });
});
