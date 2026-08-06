/**
 * A running session in an isolated state home, so a live event has something to be about.
 *
 * ── WHY THIS EXISTS, AND WHAT IT COSTS ─────────────────────────────────────────────────────────
 *
 * The last leg of the relay journey is "a real event reaches the browser over the relay". Producing
 * one needs a live session, and the daemon has NO session-create route — sessions are started by
 * the CLI launcher, which needs a published fleet account and a real agent harness. Provisioning
 * one of those inside an E2E journey buys nothing for this proof: the event feed is fed by durable
 * journal appends, and what this journey is testing is the carrier those appends cross, not the
 * agent that caused them.
 *
 * So the session is SEEDED, and this file is the honest statement of what that substitutes.
 *
 * SUBSTITUTED: how the session came to exist. A real one is launched by `fy start` against a fleet
 * account, with a tmux pane and a harness process behind it. This one is two documents.
 *
 * NOT SUBSTITUTED, and this is the part that matters: the documents are written through the
 * DAEMON'S OWN STORAGE and parsed through the protocol's own schemas first, exactly as
 * `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts` does it. A hand-written JSON
 * the schema would reject makes the live view silently empty while the test still passes — so the
 * schemas are the fixture's guard rail, not a formality. The compiled daemon then boots against
 * this home, reads these documents back with the same schemas, and everything after that — the
 * signal route, the journal append, the subscriber publish, the §14 stream session, the browser —
 * is the shipped path with nothing stubbed.
 *
 * THE ONE PRECONDITION: `status: 'running'`. `park` refuses a session that is not running, and
 * `resumeWork` returns a session that is not parked UNCHANGED — appending nothing. So the
 * waiting-then-working pair only produces its two events on a live session, and only in that order.
 *
 * This is the single place in `tests/e2e/**` that imports daemon internals rather than driving the
 * compiled binary. It is confined to seeding, it runs BEFORE the daemon boots, and it touches
 * nothing the journey later asserts on.
 */

import { SessionConfigSchema, SessionStateSchema } from '../../../packages/protocol/src/lib/index.ts';
import { buildWorld } from '../../../packages/daemon/bin/fyd.ts';
import { parseSessionId } from '../../../packages/daemon/src/lib/session-id.ts';

/** The callsign and identifiers are fixed: nothing in this journey reads them but the URL. */
export const SEEDED_SESSION_ID = 'fy_s_e2erelay0000000000001';

export interface SeededSession {
  readonly sessionId: string;
}

/**
 * Write one running session into `home`, through the daemon's own storage.
 *
 * `FY_HOME` is set on this process because `buildWorld()` resolves the state home from the
 * environment, and restored afterwards so nothing else in the suite inherits it.
 */
export async function seedRunningSession(home: string, at = new Date().toISOString()): Promise<SeededSession> {
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  try {
    const opened = await buildWorld().storage.open();
    const id = parseSessionId(SEEDED_SESSION_ID);
    await opened.storage.writeConfig(
      id,
      SessionConfigSchema.parse({
        id: SEEDED_SESSION_ID,
        incarnation: `${SEEDED_SESSION_ID}-1`,
        runtimeGeneration: 1,
        name: 'Relay Journey',
        teammate: 'ada',
        boardAccess: 'none',
        agent: 'claude-auto',
        harness: 'claude',
        modelHint: 'opus',
        mode: 'auto',
        remoteControl: false,
        harnessFlags: [],
        cwd: home,
        createdAt: at,
        updatedAt: at,
        turn: 1,
        intervalSeconds: 30,
        timeoutSeconds: 0,
        nudgeAfterSeconds: 0,
        killAfterSeconds: 0,
        directSendMaxChars: 4_096,
        resumeMenuChoice: 'full',
        maxSnapshots: 10,
        retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      }),
    );
    await opened.storage.writeState(
      id,
      SessionStateSchema.parse({ id: SEEDED_SESSION_ID, status: 'running', turn: 1, lastActivityAt: at }),
    );
    await opened.storage.close();
    return { sessionId: SEEDED_SESSION_ID };
  } finally {
    if (previous === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previous;
  }
}
