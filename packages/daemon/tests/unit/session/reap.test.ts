import { describe, it } from 'bun:test';
import should from 'should';
import {
  planTerminalReap,
  type DurableTerminalSession,
  type ObservedTerminalPane,
  type RegisteredTerminalPane,
} from '../../../src/lib/session/reap.ts';

const DAEMON = 'daemon-a';
const SESSION = 'msa1ny28-4f0f298e';

function registration(overrides: Partial<RegisteredTerminalPane> = {}): RegisteredTerminalPane {
  return {
    daemonId: DAEMON,
    sessionId: SESSION,
    tmuxSession: 'fy-msa1ny28-4f0f298e',
    paneId: '%41',
    pid: 812,
    processStartTicks: 1_002_003,
    ...overrides,
  };
}

function terminal(overrides: Partial<DurableTerminalSession> = {}): DurableTerminalSession {
  return {
    daemonId: DAEMON,
    sessionId: SESSION,
    status: 'completed',
    finishedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedTerminalPane> = {}): ObservedTerminalPane {
  const registered = registration();
  return {
    tmuxSession: registered.tmuxSession,
    paneId: registered.paneId,
    pid: registered.pid,
    processStartTicks: registered.processStartTicks,
    ...overrides,
  };
}

function plan(
  overrides: {
    readonly registrations?: readonly RegisteredTerminalPane[];
    readonly sessions?: readonly DurableTerminalSession[];
    readonly observations?: readonly ObservedTerminalPane[];
  } = {},
) {
  return planTerminalReap({
    daemonId: DAEMON,
    registrations: overrides.registrations ?? [registration()],
    sessions: overrides.sessions ?? [terminal()],
    observations: overrides.observations ?? [observed()],
  });
}

describe('terminal reap policy', () => {
  it('should select an exact registered pane only after durable terminal evidence', () => {
    should(plan().targets).deepEqual([registration()]);
    should(
      plan({ registrations: [registration({ paneId: '%0' })], observations: [observed({ paneId: '%0' })] }).targets,
    ).deepEqual([registration({ paneId: '%0' })]);
  });

  it('should refuse an unregistered pane without selecting anything to kill', () => {
    should(plan({ registrations: [] }).targets).deepEqual([]);
  });

  it('should refuse another daemon pane without selecting anything to kill', () => {
    should(plan({ registrations: [registration({ daemonId: 'daemon-b' })] }).targets).deepEqual([]);
    should(plan({ sessions: [terminal({ daemonId: 'daemon-b' })] }).targets).deepEqual([]);
  });

  it('should refuse a registered pane in a non-terminal state without selecting anything to kill', () => {
    should(plan({ sessions: [terminal({ status: 'running' })] }).targets).deepEqual([]);
  });

  it('should refuse terminal-looking state with missing or invalid durable evidence', () => {
    should(plan({ sessions: [terminal({ finishedAt: undefined })] }).targets).deepEqual([]);
    should(plan({ sessions: [terminal({ finishedAt: 'later-ish' })] }).targets).deepEqual([]);
  });

  it('should refuse a pane id recycled onto a different process incarnation', () => {
    should(plan({ observations: [observed({ processStartTicks: 1_002_004 })] }).targets).deepEqual([]);
    should(plan({ observations: [observed({ pid: 813 })] }).targets).deepEqual([]);
  });

  it('should refuse malformed or duplicate identity evidence rather than guessing', () => {
    should(plan({ observations: [observed({ paneId: '0.0' })] }).targets).deepEqual([]);
    should(plan({ observations: [observed({ paneId: '%00' })] }).targets).deepEqual([]);
    should(plan({ observations: [observed({ paneId: '%01' })] }).targets).deepEqual([]);
    should(plan({ registrations: [registration(), registration()] }).targets).deepEqual([]);
    should(plan({ registrations: [registration(), registration(), registration()] }).targets).deepEqual([]);
  });

  it('should refuse a session or a pane that two records disagree about', () => {
    // Duplicate evidence is dropped rather than resolved, on each of the three inputs independently.
    // A second record for the same key does not merely lose a tie-break: it makes the key ambiguous,
    // and a third arriving later must not resurrect it — which is why the plan tracks the ambiguity
    // rather than just deleting. Two records claiming one session is the case where guessing would
    // reap a pane on the strength of the wrong session's terminal state.
    should(plan({ sessions: [terminal(), terminal()] }).targets).deepEqual([]);
    should(plan({ sessions: [terminal(), terminal({ status: 'stopped' }), terminal()] }).targets).deepEqual([]);
    should(plan({ observations: [observed(), observed()] }).targets).deepEqual([]);
    should(plan({ observations: [observed(), observed({ pid: 902 }), observed()] }).targets).deepEqual([]);
  });
});
