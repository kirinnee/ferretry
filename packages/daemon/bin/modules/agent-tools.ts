import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FileAgentPinRepository } from '../../src/adapters/agent-pins/index.ts';
import { StorageCredentialedSessions } from '../../src/adapters/agent-tools/index.ts';
import { asActivity, KeyedSerialExecutor, NodeAgentFilesystem } from '../../src/adapters/index.ts';
import { FilePinRepository, FilePinSessionDirectory } from '../../src/adapters/pins/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  type AccountDirectory,
  type ActivityLedger,
  AgentFiles,
  type AgentCopyPagesPort,
  type AgentCopyPort,
  type AgentInputPort,
  type AgentPhoneApprovalPort,
  AgentPinService,
  AgentPinSubsystem,
  type AgentPinClock,
  type AgentPlanPort,
  AgentToolService,
  type AuditLog,
  CredentialAgentIdentities,
  CredentialDigestLocations,
  type FileSystemPort,
  type FoundationPaths,
  type LoginObserver,
  type LoginRecipeService,
  parseSessionId,
  PinService,
  type PinClock,
  type SecretRedactor,
  secretsMatch,
  type SessionDirectorySubsystem,
  type SessionId,
  type SessionAttachmentStore,
  type SignInChoicePort,
  type SignInRuleSuggestions,
  STAGED_FILE_TTL_MS,
  SurfaceControl,
  type TerminalSubsystem,
  tryParseSessionId,
  type TypedIdentities,
} from '../../src/lib/index.ts';
import type { AgentControlPolicy } from '../../src/lib/fleet/agent-control.ts';
import type { DaemonModule, LateBound } from '../../src/lib/runtime/modules.ts';
import { agentToolsContribution } from '../../src/lib/runtime/mounts/agent-tools.ts';
import type { BrowserMountedSubsystem } from '../../src/lib/runtime/mounts/browser-login.ts';

/**
 * The agent tools, and the two pin lists beside them.
 *
 *  - Agent tools: terminals and browser pages driven by name, over the SAME terminal and browser subsystems the
 *    person's routes serve, so a shell an agent opens is the shell a person sees. The agent is identified by its
 *    session credential — hashed and matched against the live sessions' stored hashes through the same directory the
 *    task boards authenticate with. Control changes are published to the session's own journal, which `/v1/events`
 *    streams to every viewer. "What agents may control" is the machine settings' own port, read per call. Takeovers and
 *    hand-overs are replayed from the same journal, so they outlive a restart.
 *  - Agent files: what the file tools may reach (the session's own folder and its attachments), and the staged copies
 *    an upload leaves, swept at boot and on a timer.
 *  - Agent pins: the owner's pinned ferrets (`POST /v1/sessions/:sessionId/pin`), which also mark the session roster.
 *  - Pins: the notes on a session's pin board (`/v1/sessions/:sessionId/pins`).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries), no jobs armed by `start()` and no releases. The browser-upload sweep (an unreferenced
 * interval and a 30-second timeout) starts while it is built, as it always did, and is never cleared.
 *
 * It is built where the agent tools always were, ahead of the shared-draft service, so the pin services (inert until a
 * request) are constructed a little before the points they used to be; the session roster the pin routes answer from
 * does not exist yet at that point, so it arrives through a {@link LateBound}.
 */

/** What the agent-tools module is built from. */
export interface AgentToolsNeeds {
  readonly paths: FoundationPaths;
  /** The state home's confined filesystem, which the pin lists are kept in. */
  readonly stateFiles: FileSystemPort;
  readonly storage: DaemonStorage;
  /** The daemon's clock, which stamps a pin. */
  readonly clock: AgentPinClock & PinClock;
  /** The binary name a person drives, which a refusal tells the owner to type. */
  readonly clientName: string;
  readonly terminals: TerminalSubsystem;
  readonly browser: BrowserMountedSubsystem;
  readonly audit: AuditLog;
  readonly policy: AgentControlPolicy;
  readonly input: AgentInputPort;
  readonly phoneApprovals: AgentPhoneApprovalPort;
  readonly scrub: (sessionId: string, text: string) => string;
  readonly quarantinedUntil: (sessionId: string, names: readonly (string | undefined)[]) => number | undefined;
  /** The vault redactor every operator read is scrubbed by; a page's text goes through it too. */
  readonly redactor: Pick<SecretRedactor, 'batch'>;
  readonly copy: AgentCopyPort;
  readonly plans: AgentPlanPort;
  readonly copyPages: AgentCopyPagesPort;
  /** The account directory (never the vault): `account.hint` reads each sign-in's non-secret projection from it. */
  readonly accounts: Pick<AccountDirectory, 'list'>;
  /** The calling session's project, folder and the owner's defaults, which order `account.hint`'s "default". */
  readonly signInChoice: SignInChoicePort;
  /** A ferret's recipe proposals, and where its acts are told so a steered sign-in fact is not kept. */
  readonly recipes: Pick<LoginRecipeService, 'propose' | 'scrubbedAccounts'>;
  /** A ferret's suggestion of a standing rule: a card for the owner and nothing else. */
  readonly ruleSuggestions: Pick<SignInRuleSuggestions, 'suggest'>;
  readonly loginActs: Pick<LoginObserver, 'acted'>;
  /** Who a page is signing in: what the agent typed into an identifier field, for the owner's card only. */
  readonly typedIdentities: Pick<TypedIdentities, 'typed' | 'seen' | 'cleared' | 'forget'>;
  /** Told where every page script runs, machine-wide: a standing rule pinned to that host stops filling. */
  readonly scriptedOrigins?: { scriptedOn(host: string | undefined): void; running?(): () => void };
  /** The folder a session works in, from its own document; nothing when the session is unknown. */
  readonly folderOf: (sessionId: string) => Promise<string | undefined>;
  /** The attachments an agent's file tool may save from. */
  readonly attachments: Pick<SessionAttachmentStore, 'download'>;
  /** The state home's key files and folders, recognised by identity wherever they are reached. */
  readonly stateHomeKeys: readonly string[];
  /** The housekeeping ledger the browser-upload sweep runs inside, or none. */
  readonly activities: ActivityLedger | undefined;
  /**
   * The session roster WITH the owner's pin mark on it, built from this module's own pin list a little later. The pin
   * routes answer from it; no route can be called before the host binds it, because the routes are mounted after
   * construction.
   */
  readonly pinnedSessions: LateBound<SessionDirectorySubsystem>;
}

/** What other code uses of the agent-tools module. */
export interface AgentToolsProvides {
  readonly service: AgentToolService;
  readonly identities: CredentialAgentIdentities;
  /** The owner's pinned ferrets: the session roster is marked from it and the archive rule keeps what it names. */
  readonly agentPins: AgentPinService;
}

/** Who an agent is, from the session credential it presents — the one resolver every agent route uses. */
export function agentIdentities(storage: DaemonStorage): CredentialAgentIdentities {
  return new CredentialAgentIdentities(
    new StorageCredentialedSessions({
      sessionIds: () => storage.listSessions().map(session => session.id),
      readConfig: async id => await storage.readConfig(id as SessionId),
      readState: async id => await storage.readState(id as SessionId),
    }),
    capability => createHash('sha256').update(capability, 'utf8').digest('hex'),
    secretsMatch,
    new CredentialDigestLocations(),
    // Every config this daemon writes (a rotation or a new session included) moves it; see CredentialAgentIdentities.
    () => String(storage.configWrites()),
  );
}

export const agentToolsModule: DaemonModule<void, AgentToolsNeeds, AgentToolsProvides> = {
  id: 'agentTools',
  build: needs => {
    const clock = { now: () => Date.now() };
    const files = (() => {
      const agentFiles = new AgentFiles({
        fs: new NodeAgentFilesystem(),
        folderOf: needs.folderOf,
        readAttachment: async (sessionId, attachmentId) => {
          const { attachment, bytes } = await needs.attachments.download(sessionId, attachmentId);
          return { filename: attachment.filename, bytes };
        },
        uploadDirectory: join(needs.paths.temporary, 'browser-upload'),
        // Every file tool stays out of these however a path reaches them (docs/agent-tools.md#files).
        stateHomes: [needs.paths.home, needs.paths.state, needs.paths.config],
        // Its key files and folders by identity too, so a bind mount of one of them alone is still refused.
        pinned: needs.stateHomeKeys,
        token: () => crypto.randomUUID().replaceAll('-', ''),
        now: () => Date.now(),
      });
      // Upload copies outlive their call by the staging time; swept at boot and on a timer, not only by the next upload.
      const sweep = asActivity(needs.activities, 'browser-upload sweep', async () => await agentFiles.sweep());
      setInterval(sweep, STAGED_FILE_TTL_MS).unref();
      setTimeout(sweep, 30_000).unref();
      return agentFiles;
    })();
    const control = new SurfaceControl(
      {
        publish: async (sessionId, type, data) => {
          const id = tryParseSessionId(sessionId);
          if (id !== undefined) await needs.storage.append(id, type, data);
        },
        history: async sessionId => {
          const id = tryParseSessionId(sessionId);
          const events: { readonly type: string; readonly data: unknown }[] = [];
          if (id === undefined || needs.storage.findSession(id) === undefined) return events;
          for (let after = 0; ; ) {
            const page = await needs.storage.replay(id, after, 10_000);
            for (const event of page.events) if (event.type.startsWith('surface.')) events.push(event);
            if (!page.hasMore || page.nextSequence === undefined) return events;
            after = page.nextSequence;
          }
        },
      },
      clock,
    );
    const service = new AgentToolService({
      terminals: needs.terminals,
      browser: needs.browser,
      control,
      policy: needs.policy,
      files,
      audit: needs.audit,
      input: needs.input,
      phoneApprovals: needs.phoneApprovals,
      scrub: needs.scrub,
      quarantinedUntil: needs.quarantinedUntil,
      copy: needs.copy,
      plans: needs.plans,
      copyPages: needs.copyPages,
      accounts: needs.accounts,
      signInChoice: needs.signInChoice,
      recipes: needs.recipes,
      ruleSuggestions: needs.ruleSuggestions,
      loginActs: needs.loginActs,
      typedIdentities: needs.typedIdentities,
      ...(needs.scriptedOrigins === undefined ? {} : { scriptedOrigins: needs.scriptedOrigins }),
      redactor: needs.redactor,
      binaryName: needs.clientName,
      clock,
      sleep: async milliseconds => await Bun.sleep(milliseconds),
    });
    const identities = agentIdentities(needs.storage);
    // The owner's pins live with the daemon of the machine that owns the ferret; the list carries them to every device.
    const agentPins = new AgentPinService(
      new FileAgentPinRepository(
        needs.paths,
        needs.stateFiles,
        async id => await needs.storage.retainSession(parseSessionId(id)),
      ),
      needs.clock,
      new KeyedSerialExecutor(),
    );
    const pins = new PinService(
      new FilePinSessionDirectory(needs.paths, needs.stateFiles),
      // Its own queue: a pin mutation must not serialize behind storage-wide or session work.
      new FilePinRepository(needs.paths, needs.stateFiles, new KeyedSerialExecutor(), needs.clock),
      needs.clock,
      // A pin id is a protocol UUID, so it is minted as one rather than derived from a counter the
      // next process would restart.
      { next: () => crypto.randomUUID() },
    );
    // Pinning answers the view the next list will show, so it reads the roster with the pin mark on it, built later
    // from `agentPins`. A route is never called before the host binds it; before that there is no roster to answer from.
    const sessionPin = new AgentPinSubsystem(
      {
        get: async reference => {
          const roster = needs.pinnedSessions.current();
          if (roster === undefined) throw new Error('the session directory is not running yet');
          return await roster.get(reference);
        },
      },
      agentPins,
    );
    return {
      id: 'agentTools',
      provides: { service, identities, agentPins },
      jobs: {},
      contributes: agentToolsContribution(service, identities, pins, sessionPin),
    };
  },
};
