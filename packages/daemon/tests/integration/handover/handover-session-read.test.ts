import { describe, it } from 'bun:test';
import should from 'should';
import { createSessionHandoverSubsystem } from '../../../bin/fyd.ts';
import type { HandoverPorts, HandoverReceipt, HandoverReceiptStore } from '../../../src/lib/handover/types.ts';
import { type SessionDirectorySubsystem, SessionReadError } from '../../../src/lib/runtime/mounts/sessions.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

/**
 * The composition root's session-read adapter: MISSING IS NOT UNREADABLE.
 *
 * WHY THIS DISTINCTION IS DESTRUCTIVE TO GET WRONG. `null` from `HandoverSessionPort.read` means the
 * session is externally ABSENT, and the handover is entitled to act on that: it may settle
 * `source_lost` — the one cause allowed to reach `failed` before the retirement tail — and it may clean
 * up a replacement it decides has no predecessor left. An adapter that answered `null` for every
 * failure would hand that authority to a corrupt document, a closed index or a transient fault, so a
 * daemon that merely could not READ a session would terminalize the handover and stop a live
 * replacement on evidence it never had.
 *
 * `SessionDirectorySubsystem.get` already draws the line — it resolves `undefined` for a session that
 * is not there and REJECTS for one it could not read — so the adapter's whole job is to preserve that
 * line rather than flatten it. The same adapter answers for the source AND for the replacement, which
 * is why both are proved here.
 */

/** A receipt store that holds nothing: these cases never reach a durable write. */
const emptyReceipts: HandoverReceiptStore = {
  read: async () => null,
  write: async () => {},
  pendingSourceSessionIds: async () => [],
};

/** The one port under test, reached through the real composition factory. */
function readPort(sessions: SessionDirectorySubsystem): HandoverPorts['sessions'] {
  const service = createSessionHandoverSubsystem(
    {
      paths: { home: '/state', sessions: '/state/sessions' } as never,
      storage: {} as never,
      sessions,
      accounts: { accounts: async () => [] },
      executables: {} as never,
      planner: {} as never,
      clock: { now: () => '2026-02-01T00:00:00.000Z' } as never,
      journalSerial: { run: async <T>(_key: string, work: () => Promise<T>) => await work() } as never,
    },
    emptyReceipts,
  );
  // The service holds the ports it was constructed with; this is the same object the ladder consults.
  return (service as unknown as { readonly ports: HandoverPorts }).ports.sessions;
}

/** A directory whose `get` answers exactly what a case wants, absent or thrown. */
function directory(answer: (sessionId: string) => Promise<unknown>): SessionDirectorySubsystem {
  return {
    list: async () => [],
    get: answer as SessionDirectorySubsystem['get'],
  };
}

describe('the handover session-read adapter', () => {
  it('should answer null for a session that is genuinely absent', async () => {
    // `undefined` from the directory is the ONE case that means "not there", and it is the only case
    // the handover may treat as external absence.
    // Arrange
    const port = readPort(directory(async () => undefined));

    // Act
    const observed = await port.read('source-1');

    // Assert
    should(observed).be.null();
  });

  it('should reject rather than answer null when the SOURCE cannot be read', async () => {
    // A document that does not parse is not a session that vanished. Answering null here would let the
    // ladder settle `source_lost` and clean up a live replacement over a read fault.
    // Arrange
    const failures = [
      new SessionReadError('unusable', 'the documents for session source-1 do not satisfy the protocol'),
      new Error('the storage index was closed'),
    ];

    // Act / Assert: both a stated read refusal and an unexpected fault propagate.
    for (const failure of failures) {
      const port = readPort(
        directory(async () => {
          throw failure;
        }),
      );
      let rejected: unknown;
      await port.read('source-1').then(
        () => undefined,
        error => {
          rejected = error;
        },
      );
      should(rejected).equal(failure);
    }
  });

  it('should reject rather than answer null when the REPLACEMENT cannot be read', async () => {
    // The same adapter answers for the replacement, and the consequence is the mirror image: a null
    // here tells cleanup the replacement does not exist, so an unreadable-but-running replacement could
    // be classified as nonexistent while it holds a board membership nothing would ever relinquish.
    // Arrange
    const failure = new SessionReadError('unusable', 'the documents for session replacement-1 do not satisfy it');
    const port = readPort(
      directory(async sessionId => {
        if (sessionId === 'replacement-1') throw failure;
        return sessionView('source-1');
      }),
    );

    // Act
    let rejected: unknown;
    await port.read('replacement-1').then(
      () => undefined,
      error => {
        rejected = error;
      },
    );

    // Assert
    should(rejected).equal(failure);
    // ...and the readable source still answers, so the rejection is about the session asked for rather
    // than a port that fails closed for everything.
    should(await port.read('source-1')).not.be.null();
  });

  it('should project a readable session into the narrow view the domain reasons about', async () => {
    // The domain deliberately reads less than the wire schema carries, and `harness` stays a raw string
    // so a family this build has never heard of can still be refused as `harness_unknown` rather than
    // being narrowed away at the boundary.
    // Arrange
    const port = readPort(directory(async () => sessionView('source-1', { harness: 'claude', parent: undefined })));

    // Act
    const observed = await port.read('source-1');

    // Assert
    should(observed?.sessionId).equal('source-1');
    should(observed?.parentSessionId).be.null();
    should(observed?.harness).equal('claude');
  });
});

/** Kept honest: the receipt type is imported so a drift in it breaks this file rather than passing. */
export type _ReceiptShape = HandoverReceipt;
