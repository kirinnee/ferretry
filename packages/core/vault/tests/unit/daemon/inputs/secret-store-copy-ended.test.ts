import { describe, it } from 'bun:test';
import should from 'should';
import type { Clock } from '@ferretry/kernel/contract';
import type { InputRaise, SecretName } from '../../../../contract/index.ts';
import { SecretStoreTarget } from '../../../../daemon/lib/inputs/secret-store-target.ts';
import { InputTargetRouter } from '../../../../daemon/lib/inputs/target-router.ts';
import type { TerminalInputTargetPort } from '../../../../daemon/lib/inputs/ports.ts';
import { SecretDirectory } from '../../../../daemon/lib/secrets/vault.ts';
import type { SecretVaultDocument } from '../../../../daemon/lib/secrets/types.ts';
import { FakeSecretCipher, MemorySecretDocuments } from '../support.ts';
import { COPY_VALUE, OWNER, PASTE_RAISE, refusal, world } from './world.ts';

/**
 * A secure copy pasted "as the secret NAME", through the PRODUCTION seam (secure-clip-1 fix3, R4): the real
 * `InputTargetRouter`, the real `SecretStoreTarget` and the real `SecretDirectory` with its serialized turn. The one thing
 * faked is the terminal the router never reaches here. The copy's end is seen INSIDE the store's turn, right before it
 * commits: one discarded, expired or captured again after it was opened, even while the write waited behind another
 * writer, ends as copy_gone with nothing written under NAME.
 */

const SESSION_ID = 'mvv6b4qw-49d0158d';
const NAME = 'TOKEN' as SecretName;
const OLD = 'FAKE-STORED-BEFORE';
const RECAPTURED = 'FAKE-SC-RECAPTURED';
const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
const AGAIN = '2026-11-01T11:30:00.000Z';
const STORE_RAISE: InputRaise = { ...PASTE_RAISE, target: { kind: 'secret', key: NAME }, sensitivity: 'secret' };

/** A document store whose writes can be held shut: the "other writer" the paste's write waits behind. */
class GatedDocuments extends MemorySecretDocuments {
  held: Promise<void> | undefined;
  writing = 0;

  override async write(document: SecretVaultDocument): Promise<void> {
    this.writing += 1;
    await this.held;
    await super.write(document);
  }
}

const terminalNeverReached: TerminalInputTargetPort = {
  observe: async () => ({ ok: false, reason: 'unsupported' }),
  type: async () => 'target_gone',
};

async function setup(exists: boolean) {
  const documents = new GatedDocuments();
  const directory = new SecretDirectory(documents, new FakeSecretCipher(), CLOCK);
  if (exists) await directory.put(NAME, OLD);
  let entered = 0;
  const store = new SecretStoreTarget({
    list: async () => await directory.list(),
    putIf: async (...args) => {
      entered += 1;
      return await directory.putIf(...args);
    },
  });
  const w = world({
    withSealed: true,
    facts: { kind: 'secret', name: NAME, exists },
    route: new InputTargetRouter(terminalNeverReached, undefined, store),
  });
  w.copy();
  await w.service.raise(SESSION_ID, STORE_RAISE);
  const request = await w.pending();
  const settle = async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  };
  return {
    w,
    documents,
    directory,
    request,
    entries: async () => JSON.stringify((await documents.read())?.entries ?? {}),
    /** Blocks the store with another writer, sends the paste, and waits until the paste is queued behind it. */
    behindAnother: async (change: () => void) => {
      let release: () => void = () => undefined;
      documents.held = new Promise<void>(resolve => {
        release = resolve;
      });
      const other = directory.put('OTHER' as SecretName, 'FAKE-OTHER');
      while (documents.writing === 0) await settle();
      const sent = w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER);
      const outcome = sent.then(
        value => ({ value }),
        (error: unknown) => ({ error: error as Error & { code?: string } }),
      );
      while (entered === 0) await settle();
      change();
      release();
      await other;
      return await outcome;
    },
  };
}

type Change = (w: Awaited<ReturnType<typeof setup>>['w']) => void;
const DISCARD: Change = w => void w.copies.delete('vercel');
const EXPIRE: Change = w => void w.copy({ state: 'expired' });
const RECAPTURE: Change = w => void w.copy({ capturedAt: AGAIN }, RECAPTURED);

const CHANGES: readonly (readonly [string, Change])[] = [
  ['discarded', DISCARD],
  ['expired', EXPIRE],
  ['captured again', RECAPTURE],
];

const assertLost = async (
  s: Awaited<ReturnType<typeof setup>>,
  before: string,
  error: (Error & { code?: string }) | undefined,
) => {
  should(error?.code).equal('gone');
  should(await s.entries()).equal(before);
  should(s.w.used).eql([]);
  should(s.w.stores).eql([]);
  should(s.w.events.at(-1)).match({ state: 'cancelled', reason: 'copy_gone' });
  const seen = JSON.stringify([s.w.events, s.w.told, s.w.closed, s.w.audits, await s.entries()]);
  should(seen).not.containEql(COPY_VALUE);
  should(seen).not.containEql(RECAPTURED);
};

describe('a copy that ends after it was opened, pasted as a named secret (secure-clip-1 fix3, R4)', () => {
  for (const exists of [true, false]) {
    for (const [what, change] of CHANGES) {
      it(`should write nothing under a ${exists ? 'held' : 'new'} name when the copy is ${what} while the attempt is journalled`, async () => {
        const s = await setup(exists);
        const before = await s.entries();
        s.w.state.onDelivering = () => change(s.w);

        const error = await refusal(
          s.w.service.deliver(SESSION_ID, s.request.id, s.w.send(s.request, { sealed: true }), OWNER),
        );

        await assertLost(s, before, error);
      });

      it(`should write nothing under a ${exists ? 'held' : 'new'} name when the copy is ${what} while the write waits behind another store write`, async () => {
        const s = await setup(exists);
        const before = await s.entries();

        const result = await s.behindAnother(() => change(s.w));

        should('error' in result).equal(true);
        // The other writer's own entry landed; NAME did not change.
        const after = JSON.parse(await s.entries()) as Record<string, unknown>;
        const { OTHER, ...rest } = after;
        should(OTHER).not.equal(undefined);
        should(JSON.stringify(rest)).equal(before);
        await assertLost(
          { ...s, entries: async () => JSON.stringify(rest) },
          before,
          'error' in result ? result.error : undefined,
        );
      });
    }
  }

  it('should still store a copy that is live and the pinned capture, also when it waited behind another store write', async () => {
    const s = await setup(true);
    const before = await s.entries();

    const result = await s.behindAnother(() => s.w.copy());

    should('value' in result && result.value).match({ state: 'delivered' });
    should(await s.entries()).not.equal(before);
    should((await s.directory.list()).map(each => each.name)).eql(['OTHER', 'TOKEN']);
    should(s.w.used).eql([{ copy: 'vercel' }]);
    should(s.w.stores).have.length(1);
  });

  it('should store a live copy into a new name straight away', async () => {
    const s = await setup(false);

    const result = await s.w.service.deliver(SESSION_ID, s.request.id, s.w.send(s.request, { sealed: true }), OWNER);

    should(result).match({ state: 'delivered' });
    should((await s.directory.list()).map(each => each.name)).eql(['TOKEN']);
  });
});
