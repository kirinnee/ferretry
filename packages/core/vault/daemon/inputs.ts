import { hostname } from 'node:os';
import {
  DAEMON_FEATURES,
  daemonFeatureList,
  InputEventSchema,
  InputQuarantineEventSchema,
  SessionStateSchema,
  type InputEvent,
  type InputQuarantineEvent,
} from '@ferretry/protocol';
import { asActivity } from '../../src/adapters/index.ts';
import { runProgram } from '../../src/adapters/terminal/index.ts';
import { ExecutableCodePrograms } from '../../src/adapters/system/executable-code-programs.ts';
import { KernelProgramProof } from '../../src/adapters/system/kernel-program-proof.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  type ActivityLedger,
  type AgendaReplyBatcher,
  type AgendaService,
  type AuditLog,
  type EphemeralValues,
  INPUT_ENDED_SESSION_STATUSES,
  INPUT_REQUEST_SWEEP_MS,
  InputAgendaAdapter,
  InputAgentNotifierAdapter,
  InputAuditAdapter,
  type InputClosestAgenda,
  InputLoginAdapter,
  InputLoginProbe,
  type InputPasteRules,
  InputRequestService,
  type InputSealedPort,
  InputTargetRouter,
  type LoginDirectory,
  type LoginFactSink,
  LoginObserver,
  PageInputTarget,
  type PageInputHost,
  PhoneApprovalAgendaAdapter,
  PhoneApprovalAuditAdapter,
  type PhoneApprovalPushPort,
  PhoneApprovalService,
  type QuarantineRegistry,
  SecretStoreTarget,
  type SecretStoreDirectory,
  type SignInChoicePort,
  type SignInGrantSource,
  SttyTerminalModes,
  TmuxInputTarget,
  tryParseSessionId,
  TypedIdentities,
  type TerminalRuntimePort,
  type TmuxCommandPort,
} from '../../src/lib/index.ts';
import type { AccountVault } from '../../src/lib/secrets/accounts.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { inputRequestsContribution } from '../../src/lib/runtime/mounts/input-requests.ts';

/**
 * The input bridge: an agent stuck at a password prompt, a code or a question asks the owner through an agenda card
 * (`/v1/input-requests`, docs/input-requests.md), and a sign-in that needs the owner's phone is approved there
 * (`/v1/phone-approvals`, "Approve on your phone").
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the dictation and browser seams are other modules'), no jobs armed by `start()` and no
 * releases: its phone-approvals restore starts while it is built, and its sweep and input-requests restore start from
 * `startInputHousekeeping`, which the host calls at the point they always ran (after the secure-copies interval); its
 * timer is unreferenced and never cleared.
 *
 * Nothing built here stores a value except the service's own in-memory map of values to scrub.
 */

/** What the input-requests module is built from. */
export interface InputRequestsNeeds {
  readonly storage: DaemonStorage;
  readonly terminals: TerminalRuntimePort;
  readonly tmux: TmuxCommandPort;
  readonly agenda: AgendaService;
  /** The open agenda an input card belongs with, so it links its topic instead of reading as a fresh one. */
  readonly closestAgenda?: InputClosestAgenda;
  readonly agentReplies: AgendaReplyBatcher;
  readonly audit: AuditLog;
  readonly values: EphemeralValues;
  readonly quarantine: QuarantineRegistry;
  readonly redact: (text: string) => Promise<string>;
  /** The directory and the vault the saved logins are read from and typed from: what the card offers, what "Use" types. */
  readonly loginDirectory: LoginDirectory;
  readonly loginVault: Pick<AccountVault, 'fill'>;
  /** The session's project, folder and the owner's defaults, which order the saved logins a card offers. */
  readonly choice: SignInChoicePort;
  /** The agent browser's pages, for a request on a page: looked at, pictured and typed into in each page's own queue. */
  readonly pages: PageInputHost;
  /** Secure copies a paste types from, and the owner's rules that approve pastes in advance. */
  readonly sealed: InputSealedPort;
  readonly rules: InputPasteRules;
  /** Where a paste "as the secret NAME" is kept. */
  readonly secretStore: SecretStoreDirectory;
  /** Where a sign-in's observed facts go: the account directory, under its store lock. */
  readonly loginFacts: LoginFactSink;
  /** An approve-on-phone card's buzz: at the raise and for each new number, inside the high-priority caps. */
  readonly approvalPush: PhoneApprovalPushPort;
  /**
   * Sign-ins the owner approved in advance, on a task plan or with a standing rule: filled only while `task-plan.1` (or
   * `sign-in-rules.1`) is advertised.
   */
  readonly grants?: SignInGrantSource;
  /** A card raised quiet that a standing rule did not fill buzzes again, with no edit to its words. */
  readonly rebuzz?: (sessionId: string) => Promise<void>;
  /** The housekeeping ledger the sweep and the restores run inside, or none. */
  readonly activities: ActivityLedger | undefined;
}

/** What other code uses of the input-requests module. */
export interface InputRequestsProvides {
  readonly service: InputRequestService;
  readonly observer: LoginObserver;
  readonly approvals: PhoneApprovalService;
  readonly identities: TypedIdentities;
  /**
   * The input-requests sweep: `input-requests-restore`, then the unreferenced interval. A CONSTRUCTION-time step the host
   * calls once, immediately after the secure-copies interval (the old position), never from `start()`.
   */
  readonly startInputHousekeeping: () => void;
}

export const inputRequestsModule: DaemonModule<void, InputRequestsNeeds, InputRequestsProvides> = {
  id: 'inputRequests',
  build: needs => {
    const clock = { now: () => Date.now() };
    const terminalTarget = new TmuxInputTarget(
      needs.tmux,
      {
        locate: async (sessionId, key) =>
          (await needs.terminals.list()).find(
            record => record.ownerId === sessionId && (record.name === key || record.id === key),
          ),
      },
      new SttyTerminalModes(process.platform, runProgram),
      runProgram,
      // An echo-off code prompt stays a code only from a code program this account cannot replace (never the ps name).
      ExecutableCodePrograms.forPlatform(process.platform),
      // Who can read the TTY, proved by the kernel for EVERY process of the foreground group, never by the name ps shows:
      // without it a card is unverified, never green, and keeps the full lock.
      KernelProgramProof.forPlatform(process.platform, runProgram, process.getuid?.()),
    );
    const pageTarget = new PageInputTarget(needs.pages);
    // What a saved login's sign-in looked like, from the daemon's own looks at the target (docs/input-requests.md,
    // "Login recipes"); the ferret's acts are reported to it, so a fact it could have steered is not kept.
    const observer = new LoginObserver({
      sink: needs.loginFacts,
      probe: new InputLoginProbe(pageTarget, terminalTarget),
      now: () => Date.now(),
      sleep: async milliseconds => await Bun.sleep(milliseconds),
    });
    // Who a page is signing in, as the ferret typed it: plain text it held already, for the owner's card only.
    const identities = new TypedIdentities(() => Date.now());
    // One of the two holders of the LoginVault (docs/secrets.md; the other is the redactor): the input bridge
    // types a saved login into the target the owner tapped "Use" for, and answers only what happened.
    const logins = new InputLoginAdapter(needs.loginDirectory, needs.loginVault);
    const service = new InputRequestService({
      observer,
      identities,
      target: new InputTargetRouter(
        terminalTarget,
        pageTarget,
        // A secure copy pasted "as the secret NAME" (docs/secure-copy.md): the vault's management surface, which
        // replaces a value and lists names, never returns one.
        new SecretStoreTarget(needs.secretStore),
      ),
      agenda: new InputAgendaAdapter(needs.agenda, needs.closestAgenda),
      notifier: new InputAgentNotifierAdapter(
        async (sessionId, key, message) => await needs.agentReplies.add(sessionId, key, message),
      ),
      journal: {
        publish: async (sessionId, event) => {
          const id = tryParseSessionId(sessionId);
          if (id !== undefined) await needs.storage.append(id, event.type, { ...event });
        },
        quarantine: async (sessionId, event) => {
          const id = tryParseSessionId(sessionId);
          if (id !== undefined) await needs.storage.append(id, event.type, { ...event });
        },
        quarantines: async sessionId => {
          const id = tryParseSessionId(sessionId);
          const events: InputQuarantineEvent[] = [];
          if (id === undefined || needs.storage.findSession(id) === undefined) return events;
          for (let after = 0; ; ) {
            const page = await needs.storage.replay(id, after, 10_000);
            for (const recorded of page.events) {
              const parsed = recorded.type.startsWith('surface.input_quarantine')
                ? InputQuarantineEventSchema.safeParse(recorded.data)
                : undefined;
              if (parsed?.success === true) events.push(parsed.data);
            }
            if (!page.hasMore || page.nextSequence === undefined) return events;
            after = page.nextSequence;
          }
        },
        history: async sessionId => {
          const id = tryParseSessionId(sessionId);
          const events: InputEvent[] = [];
          if (id === undefined || needs.storage.findSession(id) === undefined) return events;
          for (let after = 0; ; ) {
            const page = await needs.storage.replay(id, after, 10_000);
            for (const recorded of page.events) {
              const parsed = recorded.type.startsWith('surface.input_')
                ? InputEventSchema.safeParse(recorded.data)
                : undefined;
              if (parsed?.success === true) events.push(parsed.data);
            }
            if (!page.hasMore || page.nextSequence === undefined) return events;
            after = page.nextSequence;
          }
        },
      },
      audit: new InputAuditAdapter(needs.audit),
      clock,
      ids: { requestId: () => crypto.randomUUID().replaceAll('-', '') },
      timers: { after: async milliseconds => await Bun.sleep(milliseconds) },
      sessions: {
        ended: async sessionId => {
          const id = tryParseSessionId(sessionId);
          if (id === undefined || needs.storage.findSession(id) === undefined) return true;
          const state = SessionStateSchema.safeParse(await needs.storage.readState(id));
          return state.success && INPUT_ENDED_SESSION_STATUSES.has(state.data.status);
        },
        all: async () => needs.storage.listSessions().map(session => session.id),
      },
      values: needs.values,
      quarantine: needs.quarantine,
      redact: needs.redact,
      logins,
      choice: needs.choice,
      sealed: needs.sealed,
      rules: needs.rules,
      ...(needs.grants === undefined ? {} : { grants: needs.grants }),
      ...(needs.rebuzz === undefined ? {} : { rebuzz: needs.rebuzz }),
      hostName: hostname(),
    });
    // Approve on your phone (docs/input-requests.md): the number is read by the browser from the page only, and the card
    // settles only on the daemon's own look at the page or terminal; the ferret's acts are the observer's to weigh.
    const approvals = new PhoneApprovalService({
      pages: { look: async (sessionId, key) => await pageTarget.pushNumber(sessionId, key) },
      terminals: terminalTarget,
      agenda: new PhoneApprovalAgendaAdapter(needs.agenda),
      push: needs.approvalPush,
      notifier: new InputAgentNotifierAdapter(
        async (sessionId, key, message) => await needs.agentReplies.add(sessionId, key, message),
      ),
      audit: new PhoneApprovalAuditAdapter(needs.audit),
      clock,
      timers: { after: async milliseconds => await Bun.sleep(milliseconds) },
      ids: () => `pa_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
      observer,
      logins,
      facts: needs.loginFacts,
      hostName: hostname(),
      // Offered only while the daemon reports it: the app draws the card, so DAEMON_FEATURES.phoneApproval is reported.
      enabled: () => daemonFeatureList().includes(DAEMON_FEATURES.phoneApproval),
    });
    void asActivity(
      needs.activities,
      'phone-approvals-restore',
      async () => await approvals.restore(needs.storage.listSessions().map(session => session.id)),
    )();
    // Not started here: the secure-copies sweep, which `fyd.ts` builds after this module, has always been created BEFORE
    // this one, and the two share the agenda and the audit log, so the host calls this at that old point.
    const startInputHousekeeping = (): void => {
      const sweepInputRequests = asActivity(needs.activities, 'input-requests', async () => await service.sweep());
      void asActivity(needs.activities, 'input-requests-restore', async () => await service.restore())();
      setInterval(sweepInputRequests, INPUT_REQUEST_SWEEP_MS).unref();
    };
    return {
      id: 'inputRequests',
      provides: { service, observer, approvals, identities, startInputHousekeeping },
      jobs: {},
      contributes: inputRequestsContribution(service, approvals),
    };
  },
};
