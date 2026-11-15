import { describe, expect, test } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
import type { FerretId } from '../../../../../contract/index.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import {
  LastSnapshotReading,
  type LastSnapshotReader,
  type StoredLastSnapshot,
} from '../../../../../daemon/lib/session/snapshot/index.ts';

const FERRET: FerretId = ferretId('mw7bp88g-50e00159');
/** A value the Vault held when the frame was kept. Fake. */
const KEPT = 'sk-fixture-kept-0123456789abcdef';
/** A value the Vault learned AFTER the frame was kept: the file holds it as plain text. Fake. */
const LATER = 'sk-fixture-later-fedcba9876543210';

const storeOf = (answer: StoredLastSnapshot | (() => Promise<StoredLastSnapshot>)): LastSnapshotReader => ({
  read: async () => (typeof answer === 'function' ? await answer() : answer),
});

function reading(
  answer: StoredLastSnapshot | (() => Promise<StoredLastSnapshot>),
  values: Record<string, string> = {},
) {
  const vault = new Map<SecretName, string>(Object.entries(values).map(([name, value]) => [name as SecretName, value]));
  const asked: string[] = [];
  const subject = new LastSnapshotReading({
    store: id => {
      asked.push(id);
      return storeOf(answer);
    },
    redaction: new FakeRedaction(vault),
  });
  return { subject, vault, asked };
}

describe('C58-15 the stored last screen is masked AGAIN on every read', () => {
  test('C58-15 a value added to the Vault after the capture is masked on read, and one it already held stays masked', async () => {
    // Arrange: the file holds LATER as plain text (it was not a secret when the frame was kept).
    const { subject, vault } = reading({ kind: 'read', text: `$ env\nTOKEN=${LATER}\nOLD=${KEPT}\n> ` }, { OLD: KEPT });
    expect(await subject.read(FERRET)).toContain(LATER);

    // Act: the owner stores LATER in the Vault, then the screen is read again.
    vault.set('TOKEN' as SecretName, LATER);
    const out = await subject.read(FERRET);

    // Assert
    expect(out).toBeDefined();
    expect(out).not.toContain(LATER);
    expect(out).not.toContain(KEPT);
    expect(out).toContain('$ env');
  });

  test('C58-15 a value wrapped across two pane rows is masked in both (the live masker, not a plain replace)', async () => {
    const half = Math.floor(LATER.length / 2);
    const text = `${'.'.repeat(60)}${LATER.slice(0, half)}\n${LATER.slice(half)}\n> `;
    const { subject } = reading({ kind: 'read', text }, { TOKEN: LATER });

    const out = (await subject.read(FERRET)) ?? '';

    expect(out).not.toContain(LATER.slice(0, half));
    expect(out).not.toContain(LATER.slice(half));
  });

  test('C58-15 a ferret with no stored frame, or one the store cannot read, answers nothing', async () => {
    for (const answer of [{ kind: 'absent' }, { kind: 'unreadable' }] as const) {
      const { subject } = reading(answer);
      expect(await subject.read(FERRET)).toBeUndefined();
    }
  });

  test('C58-15 a store that throws answers nothing, never an error that could quote the screen', async () => {
    const { subject } = reading(async () => {
      throw new Error(`EACCES: open '/home/x/${LATER}'`);
    });

    expect(await subject.read(FERRET)).toBeUndefined();
  });

  test('C58-15 a masking failure answers nothing: the raw text is never handed on', async () => {
    // Arrange: a screen over the masker's cap is refused whole by the masker (a RangeError).
    const text = `${LATER}${'x'.repeat(262_144)}`;
    const { subject } = reading({ kind: 'read', text }, { TOKEN: LATER });
    const failing = new LastSnapshotReading({
      store: () => storeOf({ kind: 'read', text: `TOKEN=${LATER}` }),
      redaction: {
        read: async () => {
          throw new Error(`the vault is locked (${LATER})`);
        },
      },
    });

    // Assert
    expect(await subject.read(FERRET)).toBeUndefined();
    expect(await failing.read(FERRET)).toBeUndefined();
  });

  test('C58-15 a frame that is blank, or an id that names no session folder, answers nothing and touches no store', async () => {
    const blank = reading({ kind: 'read', text: '  \n \n' });
    const odd = reading({ kind: 'read', text: `TOKEN=${LATER}` }, { TOKEN: LATER });

    expect(await blank.subject.read(FERRET)).toBeUndefined();
    expect(await odd.subject.read('../etc' as FerretId)).toBeUndefined();
    expect(odd.asked).toEqual([]);
  });

  test('C58-15 a big stored screen is masked in slices through the yield it is given', async () => {
    let yields = 0;
    const filler = Array.from({ length: 300 }, () => 'ordinary terminal output'.padEnd(78, '.')).join('\n');
    const subject = new LastSnapshotReading({
      store: () => storeOf({ kind: 'read', text: `${filler}\nTOKEN=${LATER}` }),
      redaction: new FakeRedaction(new Map([['TOKEN' as SecretName, LATER]])),
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    const out = await subject.read(FERRET);

    expect(yields).toBeGreaterThan(0);
    expect(out).not.toContain(LATER);
  });
});
