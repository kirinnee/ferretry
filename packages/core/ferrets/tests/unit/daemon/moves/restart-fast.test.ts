import { describe, it } from 'bun:test';
import should from 'should';
import { restartInPlace, type RestartContext } from '../../../../daemon/modules/restart-in-place.ts';
import { currentLaunchFast } from '../../../../daemon/lib/session/launch/index.ts';
import { SessionConfigSchema, SessionStateSchema } from '../../../../daemon/lib/protocol/session.ts';
import type { SessionId } from '../../../../daemon/lib/session-id.ts';
import { launchConfig, launchState } from '../session/launch/support.ts';

/**
 * A same-runtime Restart keeps the fast mode the session is ON (U0c, item 3). The move stamp (`move.at`) is written before
 * the relaunch reads the session documents, and `currentLaunchFast` ignores a harness report older than that stamp, so a
 * `/fast off` the owner typed after the start used to be forgotten and the recorded `fast: true` came back (the paid tier).
 */
const ID = 's1' as SessionId;
const RESTARTED_AT = '2027-01-15T10:00:00.000Z';
const OFF_AT = '2027-01-15T09:00:00.000Z'; // after the start (08:00), before the Restart

/** What the relaunch's launch reads once the move stamp is in: the same read `SessionFiles.launchFast` does. */
function restarted(documents: { readonly config: Record<string, unknown>; readonly state: Record<string, unknown> }) {
  let config: Record<string, unknown> = { ...documents.config };
  const seen: { fast: boolean | undefined } = { fast: undefined };
  const ctx = {
    storage: {
      append: async () => undefined,
      readState: async () => documents.state,
      updateConfig: async (_id: SessionId, change: (current: unknown) => Record<string, unknown>) => {
        config = change(config);
      },
    },
    clock: { now: () => RESTARTED_AT },
    reports: { write: async () => '/state/report.md', append: async () => undefined },
    preflight: {
      gate: () => ({ proceed: true, forced: false }),
      document: () => ({}),
      handoff: () => '',
      settle: () => ({}),
    },
    restart: {
      record: () => ({ runtime: 'rt', harness: 'codex', handle: '%1' }),
      relaunch: async (request: { committed: () => Promise<void> }) => {
        await request.committed();
        seen.fast = currentLaunchFast(SessionConfigSchema.parse(config), SessionStateSchema.parse(documents.state));
        return { disposition: 'revived' };
      },
    },
    jobs: { keeper: () => undefined, sleep: async () => undefined, nowMs: () => 0, log: { warn: () => undefined } },
    paneIdentity: async () => '%1',
    inspect: async () => ({ worstVerdict: 'safe' }),
    refused: async () => undefined,
    view: async () => ({}),
    observed: async () => undefined,
  } as unknown as RestartContext;
  const run = async () =>
    await restartInPlace(ctx, ID, { agent: 'rt', origin: 'owner' } as never, SessionConfigSchema.parse(config));
  return { run, seen, config: () => config };
}

describe('a same-runtime Restart and the fast mode', () => {
  it('keeps /fast off: the harness report older than the move stamp is folded in before the stamp, so priority stays off', async () => {
    const world = restarted({
      config: launchConfig({ launchFast: true }),
      state: launchState({ observedFast: false, observedModelAt: OFF_AT }),
    });

    await world.run();

    should(world.seen.fast).equal(false);
    should(world.config()['launchFast']).equal(false);
  });

  it('keeps /fast on the same way, and keeps the recorded answer when nothing newer was reported', async () => {
    const turnedOn = restarted({
      config: launchConfig({ launchFast: false }),
      state: launchState({ observedFast: true, observedModelAt: OFF_AT }),
    });
    await turnedOn.run();
    should(turnedOn.seen.fast).equal(true);

    const recorded = restarted({ config: launchConfig({ launchFast: true }), state: launchState() });
    await recorded.run();
    should(recorded.seen.fast).equal(true);
  });

  it('records no fast mode for a session that never had one', async () => {
    const none = restarted({ config: launchConfig(), state: launchState() });
    await none.run();
    should(none.seen.fast).be.undefined();
    should('launchFast' in none.config()).be.false();
  });
});
