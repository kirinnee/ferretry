import { failureText, type CgroupPaneLedger, type LivePanes, type ManagedPane } from '../../lib/cgroups/index.ts';
import { hasDurableTerminalEvidence, terminalPaneIdentityMatches } from '../../lib/session/reap.ts';
import type { RegisteredPaneObserver, TerminalReapSessionDirectory } from '../../lib/session/reap-service.ts';
import type { TerminalPaneRegistrationScan } from '../session/lifecycle/durable-terminal-pane-reap.ts';

/** The tolerant half of the registration ledger — see `DurableTerminalPaneStore.scan`. */
export interface TerminalPaneRegistrationScanner {
  list(daemonId: string): Promise<TerminalPaneRegistrationScan>;
}

/**
 * The live panes a limit change could reach, from this daemon's OWN registration ledger.
 *
 * NEVER MULTIPLEXER DISCOVERY. A pane this daemon did not register is not a pane it may
 * reconfigure — listing sessions by pattern would put a person's own shell inside the set of things
 * a settings save writes properties onto. That is the same rule the reap sweep is built on, and it
 * reads the same ports so the two cannot come to disagree about what this daemon owns.
 *
 * A SESSION IS LIVE UNTIL ITS OWN DOCUMENTS PROVE OTHERWISE. `hasDurableTerminalEvidence` is the
 * single owner of that question; a registration for a session with no such evidence stays in the
 * set, so an unreadable or unrecognised state produces a warning about a pane rather than silence
 * about it.
 *
 * A PID IS NOT AN IDENTITY. The registration records the complete incarnation — tmux pane, pid and
 * start ticks — precisely because pids are recycled, and every other reader of this ledger re-proves
 * that whole tuple before acting on it. Offering a bare pid here would let a settings save read the
 * placement of, or write a property onto, whatever unrelated program now holds the number a dead
 * agent used to. So each registration is re-observed and matched through
 * `terminalPaneIdentityMatches`, the same single owner of that rule the reap uses.
 *
 * NOTHING IT CANNOT PROVE IS DROPPED. A damaged registration, an unobservable pane and a
 * disagreeing incarnation are all UNPROVEN rather than absent: absence reads as "this daemon owns
 * no such pane", which is a claim about a possibly-running agent that nobody has evidence for. The
 * domain turns each into a warning and a conservative restart requirement instead — and one
 * hand-edited file can no longer take the whole resource-limit surface down with it, which is what
 * an exception thrown from here used to do.
 */
export class RegisteredCgroupPaneLedger implements CgroupPaneLedger {
  constructor(
    private readonly daemonId: string,
    private readonly registry: TerminalPaneRegistrationScanner,
    private readonly sessions: TerminalReapSessionDirectory,
    private readonly observer: RegisteredPaneObserver,
  ) {}

  async live(): Promise<LivePanes> {
    let scanned: TerminalPaneRegistrationScan;
    let finished: ReadonlySet<string>;
    try {
      const [registrations, sessions] = await Promise.all([
        this.registry.list(this.daemonId),
        this.sessions.list(this.daemonId),
      ]);
      scanned = registrations;
      finished = new Set(
        sessions.filter(session => hasDurableTerminalEvidence(session)).map(session => session.sessionId),
      );
    } catch (error) {
      return {
        panes: [],
        unproven: [],
        incomplete: `the terminal pane registration ledger could not be read (${failureText(error)}), so no running session's resource limits can be reported or changed`,
      };
    }
    const unproven = scanned.damaged.map(damaged => ({
      sessionId: damaged.sessionId,
      failure: `${failureText(damaged.error)}, so this daemon cannot identify the pane it runs in; relaunch it once the registration is repaired`,
    }));
    const candidates = scanned.registrations.filter(
      registration => registration.daemonId === this.daemonId && !finished.has(registration.sessionId),
    );
    const observations = await Promise.all(
      candidates.map(async registration => await this.observer.observe(registration).catch(() => undefined)),
    );
    const panes: ManagedPane[] = [];
    for (const [index, registration] of candidates.entries()) {
      const observation = observations[index];
      if (observation === undefined || !terminalPaneIdentityMatches(registration, observation)) {
        unproven.push({
          sessionId: registration.sessionId,
          failure: `the pane registered for ${registration.sessionId} is no longer the incarnation this daemon launched (pid ${registration.pid}), so its resource limits are neither readable nor changeable; relaunch it`,
        });
        continue;
      }
      panes.push({ sessionId: registration.sessionId, pid: registration.pid });
    }
    return { panes, unproven };
  }
}
