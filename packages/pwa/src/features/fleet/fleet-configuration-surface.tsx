/**
 * The daemon-bound fleet cockpit: one host, one staged change, and the capability layer's own answer
 * about who may apply it.
 *
 * ## THE PASSWORD IS SPENT, NEVER STORED
 *
 * The one secret this surface touches is the operator password, and it arrives as an argument to
 * `apply` from the field that took it. It is not in `FleetSession`, and that is a rule rather than an
 * omission: session state is keyed by connection and survives every unrelated re-render, so a password
 * in there would outlive the click that needed it. Where it becomes an unlock, the minted token is held
 * for its TTL — stamped with the daemon that minted it, exactly as `src/lib/grants.ts` requires — and
 * dies with this screen.
 *
 * IT OWNS NO MODULE CACHE AND NO CROSS-DAEMON STATE. A fleet belongs to a MACHINE and this browser can
 * be paired to several, so the whole session — client, evidence, draft, proposal, held unlock and
 * result — is one value stamped with the connection it belongs to. Changing connection replaces that
 * value outright: a draft composed against one host must never be applied to another, a result from one
 * host must never be read as this one's, and an unlock minted by one daemon must never be presented to
 * another.
 *
 * A FAILED READ IS NOT AN EMPTY FLEET. Missing configuration, damaged configuration, a never-applied
 * host and a positively observed empty one each get their own state and their own sentence, decided by
 * `classifyInventory` from evidence rather than from absence.
 *
 * NOTHING IS PATCHED OPTIMISTICALLY. After an apply the manifest and configuration are re-read from
 * the daemon, including after a failure — a browser that edited its own list to match what it hoped
 * happened would be the most convincing possible lie about a host it cannot see.
 */

import { CloudOff, Layers3, Lock, Plus, ServerCog, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import { type DaemonConnection, sameDaemonConnection } from '../../lib/daemon-connection.ts';
import { type HeldUnlock, type OperatorUnlockFailure, operatorUnlockFailure, usableUnlock } from '../../lib/grants.ts';
import { unlockGrants } from '../settings/grants-api.ts';
import {
  applyFleetProposal,
  createFleetProposal,
  type FleetApplyOutcome,
  type FleetClient,
  type FleetConfigView,
  type FleetManifestAccountView,
  type FleetPermissions,
  type FleetProposalRequest,
  type FleetProposalView,
  type FleetRefusalView,
  fleetRefusal,
  type HarnessDiscoveryReport,
  listFleetAssets,
  readFleetAsset,
  readFleetConfig,
  readFleetHarnesses,
  readFleetManifest,
  readFleetPermissions,
  readFleetProposal,
} from './fleet-api.ts';
import { FleetAccountForm, FleetLayerForm, FleetProblems } from './fleet-change-forms.tsx';
import {
  accountHarnessDetection,
  accountProblems,
  applyInstructionsChoice,
  CHANGE_LIMITS,
  classifyInventory,
  createAccountProposal,
  currentUnreadable,
  daemonOutOfReach,
  declaredLayer,
  detectedAccountDraft,
  editAccountProposal,
  type FleetAccountDraft,
  fleetApplyAuthority,
  fleetApplyCopy,
  fleetApplyNeedsPassword,
  type FleetAssetKnowledge,
  type FleetInventory,
  type FleetLayerDraft,
  type FleetProbe,
  type FleetUnreadableAsset,
  initializeProposal,
  instructionsAssets,
  instructionsChoices,
  instructionsChoiceValue,
  layerDraftFrom,
  layerProblems,
  mayComposeChange,
  mayInitialize,
  outcomeSummary,
  reconcileAccountDraft,
  selectLayerAssets,
  unreachableDiagnosis,
  unreadableAssetProblems,
  unseenAssets,
} from './fleet-change-model.ts';
import {
  FleetApplyReport,
  FleetChangeReview,
  FleetFirstRunPlan,
  FleetLiveRoster,
  FleetRefusalAlert,
  FleetUnreachableNotice,
} from './fleet-change-review.tsx';
import { EYEBROW, PanelPath } from '../../shell/panel-typography.tsx';

export type FleetClientFactory = (connection: DaemonConnection) => Promise<FleetClient>;

/** What the person is composing, if anything. */
type FleetComposeMode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'create';
      readonly draft: FleetAccountDraft;
      /**
       * A new account writes asset text too, so it needs the same knowledge an edit does. Nothing is ever
       * READ here — a new account has no declared layer to load — so `loaded` stays empty and every
       * document the daemon already lists is one this browser has not seen.
       */
      readonly unreadable: readonly FleetUnreadableAsset[];
      readonly assets: FleetAssetKnowledge;
      readonly loading: boolean;
      /** True while a chosen existing document's current text is being fetched. */
      readonly reading: boolean;
    }
  | {
      readonly kind: 'edit';
      readonly accountId: string;
      readonly wrapper: string;
      readonly layer: FleetLayerDraft;
      /** Assets this layer references whose current text the browser does not hold. Blocks staging. */
      readonly unreadable: readonly FleetUnreadableAsset[];
      /**
       * What the daemon said is already in the asset tree, and which of those documents this editor
       * loaded. Kept so a path typed AFTER the load can be judged against the same evidence.
       */
      readonly assets: FleetAssetKnowledge;
      readonly loading: boolean;
    };

/**
 * A generation nothing can reconstruct, and nothing can derive from a credential.
 *
 * This is the ONLY thing that says which connection a session belongs to. A composite of daemon id,
 * address and token would be two mistakes at once: it puts the device token into React state and into
 * anything that inspects it, and it is deterministic — switch A → B → A and the third session's key
 * equals the first's, so a request issued under the original A would be accepted by the new A. A
 * monotonic mint has neither problem: every session, including a return to a byte-identical
 * connection, is a value that has never existed before and will never exist again, and it says nothing
 * about the host it belongs to.
 */
const mintGeneration = (() => {
  let issued = 0;
  return (): string => {
    issued += 1;
    return `fleet-session-${issued}`;
  };
})();

/** Everything this surface knows, stamped with the opaque generation it is true of. */
interface FleetSession {
  /** Minted once per connection. Async work that does not carry it is dropped, ABA included. */
  readonly generation: string;
  readonly client: FleetClient | null;
  /** `null` while the first read is in flight. */
  readonly inventory: FleetInventory | null;
  readonly config: FleetConfigView | null;
  readonly permissions: FleetPermissions | null;
  /**
   * What this HOST has, or `null` when this daemon did not say.
   *
   * `null` is a first-class state rather than an empty report: a form told nothing must fall back to
   * the old, unprefilled behaviour and say so, never fill boxes in from an absence of evidence.
   */
  readonly discovery: HarnessDiscoveryReport | null;
  readonly mode: FleetComposeMode;
  readonly proposal: FleetProposalView | null;
  /**
   * An unlock this screen minted, or `null`.
   *
   * The TOKEN, never the password. It is stamped with the daemon that minted it and refused for any
   * other one by `usableUnlock`, which is the rule `src/lib/grants.ts` states: one browser can be paired
   * to several machines, and a token is proof against exactly one of them. It dies with this screen.
   */
  readonly held: HeldUnlock | null;
  /** Why the last operator password was refused, in the daemon's own words. */
  readonly unlockFailure: OperatorUnlockFailure | null;
  readonly refusal: FleetRefusalView | null;
  readonly outcome: FleetApplyOutcome | null;
  readonly busy: boolean;
}

const freshSession = (generation: string): FleetSession => ({
  generation,
  client: null,
  inventory: null,
  config: null,
  permissions: null,
  discovery: null,
  mode: { kind: 'idle' },
  proposal: null,
  held: null,
  unlockFailure: null,
  refusal: null,
  outcome: null,
  busy: false,
});

/**
 * Is this refusal about a proposal the daemon no longer holds?
 *
 * Such a proposal can never be applied again, so wherever the surface learns it — an apply that was
 * refused, or a re-read that found the host had moved — it must stop offering the change rather than
 * leave an enabled button bound to a dead id.
 */
const isDead = (refusal: FleetRefusalView): boolean =>
  refusal.kind === 'proposal-gone' || refusal.kind === 'proposal-stale';

/** A read that produced evidence, or a read that produced a stated refusal. Never a silent nothing. */
const probe = async <T,>(work: () => Promise<T>): Promise<FleetProbe<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (cause) {
    return { ok: false, refusal: fleetRefusal(cause) };
  }
};

/**
 * The three codes that mean A PASSWORD ATTEMPT WAS SPENT, as opposed to a capability being refused.
 *
 * They are the ones `POST /v1/grants/unlock` answers with, and they are the ones `operatorUnlockFailure`
 * knows how to word. Every other `grant_*` code is the GUARD refusing the request — `grant_locked`,
 * `grant_not_granted`, `grant_undetermined` — and rendering one of those as "wrong password" would tell
 * somebody their typing was the problem when the operator's document was.
 */
const ATTEMPT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'grant_wrong_password',
  'grant_rate_limited',
  'grant_no_password',
]);

/**
 * WHAT THIS CALLER MAY DO NOW, re-read — or nothing said, when the read itself failed.
 *
 * Separate from `readEvidence` because it answers a different question and fails differently: evidence is
 * about the HOST's fleet, this is about this REQUEST's authority, and a failure here has to leave the
 * authority unreadable rather than leave a stale `open` on screen beside a refusal.
 */
const reReadPermissions = async (client: FleetClient, unlock?: string): Promise<Partial<FleetSession>> => {
  const read = await probe(() => readFleetPermissions(client, unlock));
  return { permissions: read.ok ? read.value : null };
};

/**
 * A SECOND CHANCE TO RETIRE a staged change, asked after a refused apply. It can only ever retire.
 *
 * THE DAEMON IS ASKED RATHER THAN THE REFUSAL INTERPRETED. A refused apply says why THAT attempt was
 * refused; it does not say whether the staged change survived, and the two come apart exactly where it
 * matters — a wrong password on a change the host has since invalidated would otherwise keep an enabled
 * Apply button bound to an id that can never be applied again.
 *
 * ## IT NEVER PUTS A PROPOSAL BACK, AND THAT IS THE CORRECTNESS RULE
 *
 * `GET /v1/fleet/proposals/:id` answers for a RECORD, and a record can outlive its applicability: a
 * `fleet_proposal_stale` apply means the configuration moved underneath the change, and the daemon may
 * still serve the proposal it can no longer honour. So this returns a retirement or nothing — the apply's
 * own verdict is never overturned by a read that merely found the row.
 *
 * A read that itself refuses for a reason other than death changes nothing on screen either: the refusal
 * already being rendered is the actionable one, and a second alert about the read would bury it.
 */
const stillHeld = async (client: FleetClient, id: string): Promise<Partial<FleetSession>> => {
  const read = await probe(() => readFleetProposal(client, id));
  if (read.ok) return read.value.state === 'consumed' ? { proposal: null } : {};
  return isDead(read.refusal) ? { proposal: null } : {};
};

const FIRST_ACCOUNT_COMMANDS = 'fy fleet init --first-account\nfy fleet apply';

/** The host-state verdict, in the header, in two words. The panel below says the rest. */
const STATE_BADGE: Readonly<Record<FleetInventory['kind'], { label: string; tone: string }>> = {
  live: { label: 'published', tone: 'ok' },
  uninitialized: { label: 'no fleet yet', tone: 'accent' },
  'not-applied': { label: 'not published', tone: 'warn' },
  damaged: { label: 'unreadable', tone: 'err' },
  forbidden: { label: 'refused', tone: 'err' },
  unreachable: { label: 'no answer', tone: 'err' },
};

/**
 * The sentence each non-live state gets, EXCEPT the one that is not a state of the host at all.
 *
 * `unreachable` is deliberately not here. It is the only entry in this table that would be a claim
 * about a machine this browser got no answer from, and the flat sentence it used to carry ("This daemon
 * did not answer") reads as a verdict on the daemon when the daemon may be serving perfectly. It is
 * worded by `unreachableDiagnosis`, which names the possibilities and the check that separates them.
 */
const INVENTORY_COPY: Readonly<
  Record<Exclude<FleetInventory['kind'], 'live' | 'unreachable'>, { title: string; body: string }>
> = {
  uninitialized: {
    title: 'This host has no fleet yet',
    body: 'There is no fleet configuration on this daemon. That is a first run, not a damaged one: preparing the host creates what is missing and never replaces a file that already exists.',
  },
  'not-applied': {
    title: 'Declared, but never published',
    body: 'This daemon has a fleet configuration and no published manifest, so nothing has been materialised from it yet. Stage a change and apply it to publish one.',
  },
  damaged: {
    title: 'Fleet state could not be read',
    body: 'This daemon could not serve a valid configuration or manifest. That is NOT an empty fleet, and Ferretry will not show it as one — the accounts on this host are unknown from here until it reads.',
  },
  forbidden: {
    title: 'This credential may not read the fleet',
    body: 'The daemon refused this browser the fleet read. Nothing about the host is known from here.',
  },
};

export interface FleetConfigurationSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient?: FleetClientFactory;
  /**
   * Now, supplied rather than read, so a held unlock's expiry is deterministic in a test.
   *
   * The same seam `GrantsSurface` takes for the same reason. Nothing here counts down on screen; the
   * clock exists so `usableUnlock` can refuse an expired token rather than presenting one the daemon
   * will reject.
   */
  readonly now?: () => number;
  /**
   * The scheme this page is served over, exactly as `location.protocol` spells it.
   *
   * Supplied so both halves of the unreachable diagnosis can be driven in a test, and read from the
   * page by default. IT DECIDES COPY AND NOTHING ELSE: an `https` page fetching an `http` address is a
   * mixed request some browsers refuse, which is worth saying to somebody staring at a failure that
   * looks like a stopped daemon. Nothing about authority, locality or governance is derived from it —
   * `src/lib/grants.ts` states why that would be the worst bug in this feature.
   */
  readonly pageScheme?: string;
}

export function FleetConfigurationSurface({
  connection,
  createClient = daemonApiClient,
  now = Date.now,
  pageScheme = window.location.protocol,
}: FleetConfigurationSurfaceProps) {
  // Instance-local, because one page may hold more than one cockpit: the harness states frame mounts
  // four. Module-global ids there left three sections labelled by another daemon's heading and put four
  // permanent live regions in one document, so that frame could not be trusted as accessibility
  // evidence — which is the one thing it exists for.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const [session, setSession] = useState<FleetSession>(() => freshSession(mintGeneration()));

  /**
   * Which connection the state on screen belongs to.
   *
   * The ref HOLDS THE CONNECTION OBJECT — credential included, exactly as the props do. That is the
   * point: nothing is derived from it. `sameDaemonConnection` is the shared liveness test and compares
   * field by field, including the relay carrier, precisely because neither of the cheap alternatives
   * works — object identity is wrong (a host that rebuilds an equivalent object each render has not
   * re-paired, and resetting on that would throw away a draft somebody is typing), and a derived key
   * string is worse still, because a string containing the device token can end up in state, a DOM
   * attribute or a log line.
   *
   * The reset happens during render rather than in the effect, so a roster from the previous connection
   * is never painted, not even for one frame. The generation it mints is the only identity that leaves
   * this block.
   */
  const shownFor = useRef(connection);
  if (!sameDaemonConnection(shownFor.current, connection)) {
    shownFor.current = connection;
    setSession(freshSession(mintGeneration()));
  }
  const generation = session.generation;

  /** Applies a change only while it is still true of the connection it was started for. */
  const patch = useCallback((generation: string, changes: Partial<FleetSession>): void => {
    setSession(previous => (previous.generation === generation ? { ...previous, ...changes } : previous));
  }, []);

  const readEvidence = useCallback(async (client: FleetClient): Promise<Pick<FleetSession, 'inventory' | 'config'>> => {
    const [manifest, config] = await Promise.all([
      probe(() => readFleetManifest(client)),
      probe(() => readFleetConfig(client)),
    ]);
    return { inventory: classifyInventory(manifest, config), config: config.ok ? config.value : null };
  }, []);

  /**
   * Read this connection once, keyed by the GENERATION rather than by the connection object.
   *
   * Structural, so nothing rests on the `live` flag catching an interleaving: a new generation exists
   * exactly when `sameDaemonConnection` said this is a different live connection, and a caller that
   * merely rebuilt an equal object produces no new generation and therefore no second read.
   */
  useEffect(() => {
    const target = shownFor.current;
    let live = true;
    void (async () => {
      const opened = await probe(() => createClient(target));
      if (!live) return;
      if (!opened.ok) {
        patch(generation, { inventory: { kind: 'unreachable', detail: opened.refusal.detail } });
        return;
      }
      const client = opened.value;
      const permissions = await probe(() => readFleetPermissions(client));
      const evidence = await readEvidence(client);
      // The harness read is a separate probe on purpose: a daemon too old to serve it, or a credential
      // refused it, must still produce a working fleet panel. A failure here means "nothing was
      // detected", which the form states, rather than a panel that will not load.
      const discovery = await probe(() => readFleetHarnesses(client));
      if (!live) return;
      patch(generation, {
        client,
        permissions: permissions.ok ? permissions.value : null,
        discovery: discovery.ok ? discovery.value : null,
        ...evidence,
      });
    })();
    return () => {
      live = false;
    };
  }, [generation, createClient, patch, readEvidence]);

  const client = session.client;
  /**
   * Announcement and focus for the two transitions that replace a panel.
   *
   * A live region has to be in the DOM BEFORE its content changes, so the region below is permanent and
   * only its text moves; a `role="status"` inserted along with its own content is announced by almost
   * nothing. Staging unmounts the form and applying unmounts the review, so focus would land on `body`
   * both times — each new panel takes it instead.
   */
  const reviewRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  /**
   * Where focus goes when a panel is DISMISSED rather than opened.
   *
   * Discarding unmounts the element focus is sitting on, and the browser then drops focus to `<body>` —
   * a keyboard reader loses their place entirely and has to tab in from the top of the document. The
   * header's own control is the stable answer: it survives every one of these transitions, and it is
   * what a person reaches for next anyway.
   */
  const anchorRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  /**
   * Where focus goes when the create panel is OPENED.
   *
   * "Add account" is the one compose trigger that unmounts itself — the header offers it only while
   * nothing is being composed — so the element focus was sitting on disappears and the browser drops
   * focus to `<body>`. The panel takes it instead, and the panel rather than a field on purpose: while the
   * asset listing is in flight every control inside is disabled, so there is nothing else focusable, and
   * a `tabIndex={-1}` region with a name is a landing place that exists in both states. Keyed to the
   * mounted state in an effect rather than scheduled beside the click, because focus has to move AFTER
   * the render that mounts the panel, and a microtask that races that render is a coin toss.
   */
  const createRef = useRef<HTMLElement>(null);
  const proposalId = session.proposal?.id ?? null;
  const outcomeKind = session.outcome?.outcome ?? null;
  const composeKind = session.mode.kind;
  useEffect(() => {
    if (proposalId !== null) reviewRef.current?.focus();
  }, [proposalId]);
  useEffect(() => {
    if (outcomeKind !== null) reportRef.current?.focus();
  }, [outcomeKind]);
  useEffect(() => {
    // Only on the transition INTO create. Re-running while the person types would fight the caret, and
    // `composeKind` is exactly the value that does not change as a draft changes.
    if (composeKind === 'create') createRef.current?.focus();
  }, [composeKind]);

  /** Dismiss a panel and put focus somewhere a keyboard can carry on from. */
  const dismissed = useCallback(
    (changes: Partial<FleetSession>): void => {
      patch(generation, changes);
      // After the render that removed the panel, not before it: the anchor may not be mounted yet.
      queueMicrotask(() => (anchorRef.current ?? surfaceRef.current)?.focus());
    },
    [generation, patch],
  );

  const stage = useCallback(
    async (request: FleetProposalRequest): Promise<void> => {
      if (client === null) return;
      patch(generation, { busy: true, refusal: null, outcome: null });
      try {
        patch(generation, { proposal: await createFleetProposal(client, request) });
      } catch (cause) {
        patch(generation, { refusal: fleetRefusal(cause) });
      } finally {
        patch(generation, { busy: false });
      }
    },
    [client, generation, patch],
  );

  /**
   * Open one account's layer, with the CURRENT text of every asset it references.
   *
   * The whole referenced tree is enumerated — the instructions file and every document under the
   * skills directory — because a layer that declares a directory declares everything in it. Anything
   * that cannot be read is kept as an explicit entry and blocks staging: the editor would otherwise
   * send empty text for a document nobody has seen, and apply would write that over the real one.
   *
   * The INDEX is listed even for a layer that declares no assets at all, because the person can type a
   * path this editor never loaded — an existing document — and judging that needs the daemon's answer to
   * "what is already there". Only the per-document READS are scoped to what the layer declares.
   */
  const startEdit = useCallback(
    (account: FleetManifestAccountView): void => {
      const declared = layerDraftFrom(declaredLayer(session.config, account.id));
      patch(generation, {
        mode: {
          kind: 'edit',
          accountId: account.id,
          wrapper: account.wrapper,
          layer: declared,
          unreadable: [],
          assets: { listed: [], loaded: [] },
          loading: client !== null,
        },
        proposal: null,
        outcome: null,
        refusal: null,
      });
      if (client === null) return;

      void (async () => {
        const index = await probe(() => listFleetAssets(client));
        const selection = index.ok
          ? selectLayerAssets(index.value, declared.instructions.path, declared.skillsDirectory)
          : {
              readable: [],
              // A tree nobody could list is a tree whose contents are unknown: a `tree` blocker, so no
              // edit in the browser can clear it.
              unreadable: [{ scope: 'tree' as const, path: 'fleet/assets', reason: index.refusal.detail }],
            };
        const unreadable = [...selection.unreadable];
        const listed = index.ok ? index.value.files.map(file => file.path) : [];
        const loaded: string[] = [];
        let instructions = declared.instructions;
        const skills: { id: string; path: string; text: string }[] = [];
        for (const path of selection.readable) {
          const document = await probe(() => readFleetAsset(client, path));
          if (!document.ok) {
            unreadable.push({ scope: 'file', path, reason: document.refusal.detail });
            continue;
          }
          loaded.push(path);
          if (path === declared.instructions.path) instructions = { path, text: document.value.content };
          else skills.push({ id: path, path, text: document.value.content });
        }
        setSession(previous => {
          if (previous.generation !== generation || previous.mode.kind !== 'edit') return previous;
          if (previous.mode.accountId !== account.id) return previous;
          return {
            ...previous,
            mode: {
              ...previous.mode,
              layer: { ...previous.mode.layer, instructions, skills },
              unreadable,
              assets: { listed, loaded },
              loading: false,
            },
          };
        });
      })();
    },
    [client, generation, patch, session.config],
  );

  /**
   * Applies the staged change, spending the typed password on EVERY step that needs it.
   *
   * ## THE HUMAN TYPES IT AT MOST ONCE, AND THAT IS THE WHOLE POINT OF THIS FUNCTION
   *
   * `locked` and `confirm` are not alternatives. A remote caller on a machine with an operator password
   * is locked AND owes a per-change confirmation, and the panel above shows ONE field for that case —
   * so the value arrives here once and is used twice: minted into an unlock, which is what stops the
   * request being refused before the handler sees it, and then sent as `operatorPassword`, which is the
   * confirmation bound to this exact diff. Prompting twice for one click is the disease this whole change
   * is curing, and it would come back here first.
   *
   * A held unlock is reused rather than re-minted, so somebody who unlocked a minute ago and now applies
   * a `confirm`-only change spends one attempt, not two.
   *
   * ## A WRONG PASSWORD STOPS AT THE UNLOCK
   *
   * The mint is the cheap half and it is the one that reports "wrong password, four tries left". If it
   * refuses, the apply is never sent — the change stays staged, the reason is on screen in the daemon's
   * own words, and the person retypes. Sending the apply anyway would spend the change's own attempt on
   * a secret already known to be wrong.
   *
   * The typed value is a PARAMETER for the whole of its life. It is never patched into session state.
   */
  const apply = useCallback(
    async (operatorPassword?: string): Promise<void> => {
      const proposal = session.proposal;
      if (client === null || proposal === null) return;
      const authority = fleetApplyAuthority(session.permissions);
      if (authority.kind === 'refused' || (fleetApplyNeedsPassword(authority) && operatorPassword === undefined))
        return;
      patch(generation, { busy: true, refusal: null, unlockFailure: null });
      // Hoisted out of the `try` so the failure path can re-read authority AS the caller this browser now
      // is: a mint that succeeded before an apply that did not still moved this caller past the gate.
      let unlock = usableUnlock(session.held, connection.daemonId, now());
      try {
        if (authority.kind === 'locked' && unlock === undefined) {
          // `operatorPassword` is defined here: `fleetApplyNeedsPassword` is true for `locked`, and the
          // guard above returned for an absent one.
          const minted = await unlockGrants(client, String(operatorPassword));
          const held = {
            daemonId: connection.daemonId,
            token: minted.token,
            expiresAtMs: Date.parse(minted.expiresAt),
          };
          patch(generation, { held });
          unlock = minted.token;
        }
        const outcome = await applyFleetProposal(client, proposal.id, {
          // The confirmation is sent only where the daemon SAID it would be asked for. A password on a
          // request that did not want one is a secret on the wire for nothing.
          ...(authority.kind === 'locked' && !authority.alsoConfirms ? {} : { operatorPassword }),
          ...(unlock === undefined ? {} : { unlock }),
        });
        // Positive evidence, re-read. The list on screen is what the daemon holds, never what we hoped.
        patch(generation, {
          outcome,
          proposal: null,
          mode: { kind: 'idle' },
          ...(await readEvidence(client)),
          // AND WHAT THIS CALLER MAY DO NOW, asked WITH the unlock this screen holds. This is the second
          // half of the sudo shape: past the gate, the panel must stop advertising a gate. Without this
          // read the permissions on screen are the ones from before the unlock existed, so the next change
          // would prompt for a password the daemon would no longer ask for — the mechanism getting out of
          // the way while the presentation did not, which is the whole defect being repaired here.
          ...(await reReadPermissions(client, unlock)),
        });
      } catch (cause) {
        const refusal = fleetRefusal(cause);
        // A failed PASSWORD ATTEMPT is worded by the grants vocabulary rather than as a fleet refusal,
        // because "that is not this machine's operator password, four attempts remaining" is the sentence a
        // person can act on and a generic fleet alert would bury it. Keyed to the three codes the unlock
        // route itself answers with — which are exactly the ones `operatorUnlockFailure` can read — so a
        // governance refusal raised by the guard is NOT dressed up as a typo.
        const spentAttempt = ATTEMPT_FAILURE_CODES.has(refusal.code ?? '');
        patch(generation, {
          ...(spentAttempt ? { unlockFailure: operatorUnlockFailure(cause) } : { refusal }),
          // WHAT THIS CALLER MAY DO, re-read. A refusal is frequently the news that the grant state moved
          // under this screen — `grant_locked` on a panel whose permissions said `open` is exactly that —
          // and leaving the old answer up would leave a person with a refusal and no control to resolve
          // it, which is the dead end this feature exists to remove. It is a probe: a permissions read
          // that fails leaves `unreadable` rather than a claim about the operator's decisions.
          ...(await reReadPermissions(client, unlock)),
          // TWO INDEPENDENT WAYS TO LEARN THE CHANGE IS DEAD, and both are read. The refusal itself says so
          // when the daemon refused BECAUSE the proposal is gone or stale; the re-read catches the other
          // case, where the apply was refused for something else — a wrong password, a held lock — and the
          // host moved underneath the change in the same moment. Leaving an enabled Apply bound to a
          // proposal that can never be applied again is the one outcome worse than either answer alone.
          ...(isDead(refusal) ? { proposal: null } : await stillHeld(client, proposal.id)),
          ...(await readEvidence(client)),
        });
      } finally {
        patch(generation, { busy: false });
      }
    },
    [
      client,
      connection.daemonId,
      generation,
      now,
      patch,
      readEvidence,
      session.held,
      session.permissions,
      session.proposal,
    ],
  );

  if (session.inventory === null) {
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Reading this daemon's fleet">
        <p className="m-0 text-ui text-faint">Reading this daemon’s fleet…</p>
      </section>
    );
  }

  const inventory = session.inventory;
  // Bound to a local so the narrowing survives into the callbacks below.
  const mode = session.mode;
  const authority = fleetApplyAuthority(session.permissions);
  const authorityCopy = fleetApplyCopy(authority);
  const live = inventory.kind === 'live' ? inventory.manifest.accounts : [];
  const composable = mayComposeChange(inventory) && session.permissions?.mayPropose === true;
  const variants = Object.keys(session.config?.variants ?? {});
  const detection = accountHarnessDetection(session.discovery, live);
  const composing = mode.kind !== 'idle' || session.proposal !== null;
  /**
   * ONE ANSWER TO "can this browser reach the daemon", read by every control that needs one.
   *
   * Computed here rather than asked per control, because the shape of the defect this repairs is a
   * panel where one place knew and the others did not: the read said `unreachable` and the staged
   * change went on offering a password field to a limiter nothing could ask.
   */
  const unreachable = daemonOutOfReach(inventory, session.refusal)
    ? unreachableDiagnosis(connection.baseUrl, pageScheme)
    : null;
  /** Bound to a local so the preview's discriminant narrows into the two panels below. */
  const staged = session.proposal;
  /**
   * ONE SET OF AUTHORITY CONTROLS, handed to whichever panel is offering the action.
   *
   * The two panels must ask for the operator password identically. Spelling the same six props twice is
   * how the second one ends up a version behind — which is the shape of every divergence this feature
   * has already been repaired for.
   */
  const applyControls = {
    authority,
    busy: session.busy,
    unlockFailure: session.unlockFailure,
    unreachable,
    onApply: (operatorPassword?: string) => void apply(operatorPassword),
    onDiscard: () => dismissed({ proposal: null, refusal: null, unlockFailure: null }),
  };

  /**
   * Open the create form, with the daemon's answer to what is already in the asset tree.
   *
   * A new account's layer carries asset text like any other, so naming a document that is already there
   * would write over it — the same overwrite an edit is stopped from making, by another route. Nothing is
   * read: there is no declared layer to load, so every listed path counts as unseen, and a listing that
   * refused or stopped at a bound leaves an unconditional `tree` blocker behind.
   */
  const startCreate = (): void => {
    patch(generation, {
      mode: {
        kind: 'create',
        // Opened ALREADY FILLED IN from what the daemon detected, rather than opened blank and then
        // patched: a form that flickers from empty to prefilled is a form whose first frame is a lie
        // about what a person has to type.
        draft: detectedAccountDraft(detection, session.discovery),
        unreadable: [],
        assets: { listed: [], loaded: [] },
        loading: client !== null,
        reading: false,
      },
      outcome: null,
      refusal: null,
    });
    if (client === null) return;

    void (async () => {
      const index = await probe(() => listFleetAssets(client));
      const unreadable = index.ok
        ? selectLayerAssets(index.value, '', '').unreadable
        : [{ scope: 'tree' as const, path: 'fleet/assets', reason: index.refusal.detail }];
      const listed = index.ok ? index.value.files.map(file => file.path) : [];
      setSession(previous => {
        if (previous.generation !== generation || previous.mode.kind !== 'create') return previous;
        return {
          ...previous,
          mode: { ...previous.mode, unreadable, assets: { listed, loaded: [] }, loading: false },
        };
      });
    })();
  };

  /**
   * Point this account at a document, and — for one that already exists — read what is in it.
   *
   * The read is what makes choosing a shared document safe rather than destructive. Until its text is
   * here, the draft holds an empty string for a path the daemon has listed, and `unseenAssets` blocks
   * staging on exactly those terms: the alternative is a change that quietly replaces somebody's house
   * rules with nothing. A refusal is kept as the daemon's own sentence, so the blocker says WHY.
   */
  const chooseInstructions = (create: Extract<FleetComposeMode, { readonly kind: 'create' }>, value: string): void => {
    const chosen = applyInstructionsChoice(create.draft, value, session.discovery);
    const path = chosen.load;
    patch(generation, {
      mode: { ...create, draft: chosen.draft, reading: path !== undefined && client !== null },
    });
    if (path === undefined || client === null) return;

    void (async () => {
      const document = await probe(() => readFleetAsset(client, path));
      setSession(previous => {
        if (previous.generation !== generation || previous.mode.kind !== 'create') return previous;
        // The person may have chosen something else while this was in flight. A late answer must never
        // overwrite the document they are looking at now.
        if (previous.mode.draft.layer.instructions.path !== path) return previous;
        const create = previous.mode;
        return {
          ...previous,
          mode: document.ok
            ? {
                ...create,
                reading: false,
                assets: { ...create.assets, loaded: [...create.assets.loaded, path] },
                draft: {
                  ...create.draft,
                  layer: { ...create.draft.layer, instructions: { path, text: document.value.content } },
                },
              }
            : {
                ...create,
                reading: false,
                unreadable: [...create.unreadable, { scope: 'file', path, reason: document.refusal.detail }],
              },
        };
      });
    })();
  };

  return (
    <section
      className="space-y-3"
      ref={surfaceRef}
      tabIndex={-1}
      data-fleet-configuration=""
      data-fleet-daemon-id={String(connection.daemonId)}
      aria-labelledby={id('-configuration-heading')}
    >
      <p className="sr-only" role="status" data-fleet-announcement="">
        {session.busy
          ? 'Working…'
          : session.outcome === null
            ? session.proposal === null
              ? ''
              : // A first run is not staged for review, and saying it is would announce the ceremony
                // this panel no longer shows to anybody reading it with their eyes.
                session.proposal.preview.kind === 'initialize'
                ? 'This host is ready to be prepared, showing every file it would create.'
                : 'A change is staged and waiting for review.'
            : outcomeSummary(session.outcome).title}
      </p>
      <header className="kt-panel overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border-soft bg-surface-2 px-panel py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
            <Layers3 size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            {/* An <h2>, not an <h1>: this renders inside a settings tab panel whose page already has
                one. A second <h1> is an outline bug outright. */}
            <h2
              id={id('-configuration-heading')}
              className="m-0 font-display text-title font-bold tracking-display text-fg"
            >
              Fleet
            </h2>
            {/* WHICH HOST. A browser can be paired to several, and every path, wrapper and operation
                below belongs to exactly this one. */}
            <PanelPath value={String(connection.daemonId)} className="text-meta text-muted" label="Daemon" />
          </div>
          <span
            className="kt-badge"
            data-tone={STATE_BADGE[inventory.kind].tone}
            data-fleet-state-badge={inventory.kind}
          >
            {STATE_BADGE[inventory.kind].label}
          </span>
          {/* The SHARED grant vocabulary, in the shared badge. The fleet used to word this itself
              ('Approval required'), which is exactly how one capability came to describe its authority in
              terms no other capability used. */}
          <span className="kt-badge ml-auto" data-tone={authorityCopy.tone} data-fleet-authority-mode={authority.kind}>
            {authority.kind === 'open' ? (
              <ShieldCheck size={12} aria-hidden="true" />
            ) : (
              <Lock size={12} aria-hidden="true" />
            )}
            {authorityCopy.badge}
          </span>
        </div>
        {composable && !composing ? (
          <div className="flex flex-wrap gap-2 px-panel py-3">
            <button
              ref={anchorRef}
              type="button"
              className="kt-btn"
              data-variant="primary"
              data-fleet-start-create=""
              onClick={startCreate}
            >
              <Plus size={14} aria-hidden="true" />
              Add account
            </button>
          </div>
        ) : null}
      </header>

      {inventory.kind === 'live' ? null : (
        <section
          className={cn(
            'kt-panel p-panel',
            inventory.kind === 'uninitialized' || inventory.kind === 'not-applied' ? '' : 'border-warn-border',
          )}
          data-fleet-state={inventory.kind}
          aria-labelledby={id('-state-heading')}
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 shrink-0 text-warn">
              {inventory.kind === 'uninitialized' ? (
                <ServerCog size={16} aria-hidden="true" />
              ) : inventory.kind === 'unreachable' ? (
                <CloudOff size={16} aria-hidden="true" />
              ) : (
                <TriangleAlert size={16} aria-hidden="true" />
              )}
            </span>
            {inventory.kind === 'unreachable' ? (
              // The one state whose remedy is never on this screen, so it gets the checks and no
              // control at all — not even a re-read, which is what reopening the tab already does.
              <FleetUnreachableNotice
                diagnosis={unreachableDiagnosis(connection.baseUrl, pageScheme)}
                detail={inventory.detail}
                headingId={id('-state-heading')}
              />
            ) : (
              <div className="min-w-0">
                <h3 id={id('-state-heading')} className="m-0 text-title font-semibold text-fg">
                  {INVENTORY_COPY[inventory.kind].title}
                </h3>
                <p className="mb-0 mt-1 text-ui leading-base text-muted">{INVENTORY_COPY[inventory.kind].body}</p>
                {/* WHICH refusal this is, when the operator is the one refusing. "This credential may
                  not read the fleet" is true of all three and actionable for none of them: switched
                  off on the host, needs the operator password, and a daemon that has lost its own
                  decision send a person three different places. */}
                {inventory.kind === 'forbidden' && inventory.grant !== undefined ? (
                  <p
                    className="mb-0 mt-2 text-ui font-semibold leading-base text-fg"
                    data-fleet-state-grant={inventory.grant.refusal}
                  >
                    {inventory.grant.guidance.explanation}
                  </p>
                ) : null}
                <pre className="m-0 mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta leading-base text-muted">
                  {inventory.detail}
                </pre>
                {mayInitialize(inventory) && session.permissions?.mayPropose === true && session.proposal === null ? (
                  <button
                    type="button"
                    className="kt-btn mt-3"
                    data-variant="primary"
                    data-fleet-start-initialize=""
                    onClick={() => void stage(initializeProposal())}
                  >
                    Prepare this host
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </section>
      )}

      {session.outcome === null ? null : (
        <div ref={reportRef} tabIndex={-1}>
          <FleetApplyReport outcome={session.outcome} />
        </div>
      )}

      {session.refusal === null || session.proposal !== null ? null : (
        <div className="kt-panel overflow-hidden py-1">
          <FleetRefusalAlert refusal={session.refusal} />
        </div>
      )}

      {/* Two columns ONLY when there is a second thing to show. A lone roster in a half-width column
          with dead space beside it reads as a missing panel. */}
      {/* ONE COLUMN, deliberately, and the reason is arithmetic rather than taste. The settings shell
          caps its content at 1080px, so a two-column split gave each panel about 520px — and an absolute
          wrapper path does not fit in 520px, which is why every path on this screen was being torn apart
          mid-token to make it. Stacked, each panel gets the whole measure and the paths stay whole. */}
      <div className="grid min-w-0 gap-3">
        {inventory.kind === 'live' ? (
          <FleetLiveRoster
            accounts={live}
            generatedAt={inventory.manifest.generatedAt}
            onEdit={startEdit}
            editable={composable && session.proposal === null}
          />
        ) : null}

        {staged === null ? null : (
          <div ref={reviewRef} tabIndex={-1} className="min-w-0">
            {/* TWO OPERATIONS, TWO PANELS. A first run creates what is missing and can replace nothing,
                so it is one action and the list it will write; a change to a configuration that exists
                is a diff somebody has to read and a revision a concurrent writer can move underneath.
                Rendering both through one component is what dressed "create these directories" in an
                expiry, a revision and a review step. */}
            {staged.preview.kind === 'initialize' ? (
              <FleetFirstRunPlan
                scaffold={staged.preview.scaffold}
                documents={staged.preview.documents}
                {...applyControls}
              />
            ) : (
              <FleetChangeReview
                proposal={{ ...staged, preview: staged.preview }}
                live={live}
                refusal={session.refusal}
                {...applyControls}
              />
            )}
          </div>
        )}

        {/* A named region rather than a bare div: `aria-label` on an element with no role names nothing,
            and this element exists to BE the landing place focus is sent to when the panel opens. */}
        {session.proposal === null && mode.kind === 'create' ? (
          <section className="kt-panel overflow-hidden" ref={createRef} tabIndex={-1} aria-label="New account">
            <FleetAccountForm
              draft={mode.draft}
              // Every edit goes through ONE reconciliation: the field they touched stops claiming to be
              // detected, a harness change refills what the old harness was speaking for, and the
              // derived document name keeps up with the account until they name their own.
              onChange={draft =>
                patch(generation, {
                  mode: { ...mode, draft: reconcileAccountDraft(mode.draft, draft, session.discovery) },
                })
              }
              onSubmit={() => void stage(createAccountProposal(mode.draft))}
              onCancel={() => dismissed({ mode: { kind: 'idle' }, refusal: null })}
              problems={[
                // The same one filter an edit goes through. A new account has loaded nothing, so any
                // document the daemon already lists is text this browser has never seen.
                ...unreadableAssetProblems(
                  currentUnreadable(
                    [...mode.unreadable, ...unseenAssets(mode.draft.layer, mode.assets)],
                    mode.draft.layer,
                  ),
                ),
                ...accountProblems(mode.draft, session.config),
              ]}
              disabled={session.busy || mode.loading}
              loading={mode.loading}
              detection={detection}
              instructions={{
                choices: instructionsChoices(
                  mode.draft,
                  session.discovery,
                  instructionsAssets(mode.assets.listed, session.config),
                ),
                value: instructionsChoiceValue(mode.draft, instructionsAssets(mode.assets.listed, session.config)),
                onChoose: value => chooseInstructions(mode, value),
                loading: mode.reading,
              }}
              variants={variants.length === 0 ? ['default'] : variants}
            />
          </section>
        ) : null}

        {session.proposal === null && mode.kind === 'edit' ? (
          <div className="kt-panel overflow-hidden">
            <FleetLayerForm
              wrapper={mode.wrapper}
              layer={mode.layer}
              onChange={layer => patch(generation, { mode: { ...mode, layer } })}
              onSubmit={() => void stage(editAccountProposal(mode.accountId, mode.layer))}
              onCancel={() => dismissed({ mode: { kind: 'idle' }, refusal: null })}
              problems={[
                // Recomputed against the CURRENT draft each render: clearing the reference clears the
                // blocker, while a truncated walk keeps blocking whatever the person types. Load-time
                // evidence and the paths the draft newly names go through ONE filter, so a document that
                // exists and was never loaded blocks on exactly the terms an unreadable one does.
                ...unreadableAssetProblems(
                  currentUnreadable([...mode.unreadable, ...unseenAssets(mode.layer, mode.assets)], mode.layer),
                ),
                ...layerProblems(mode.layer),
              ]}
              disabled={session.busy || mode.loading}
              loading={mode.loading}
            />
          </div>
        ) : null}
      </div>

      <section className="kt-panel px-panel py-3" aria-labelledby={id('-limits-heading')}>
        <p className={EYEBROW} id={id('-limits-heading')}>
          Known limits
        </p>
        <ul className="m-0 mt-1 list-none space-y-1 p-0">
          {CHANGE_LIMITS.map(limit => (
            <li key={limit} className="text-meta leading-base text-muted">
              {limit}
            </li>
          ))}
        </ul>
        {/* Keyed to what the credential MAY do, not to whether a change is composable right now: a
            first run offers 'Prepare this host', and saying 'cannot stage a change' beside that button
            contradicts the screen. */}
        <FleetProblems
          problems={
            session.permissions?.mayPropose === true ? [] : ['This credential cannot stage a change on this daemon.']
          }
        />
        {session.permissions?.mayPropose === true ? null : (
          <section
            className="mt-3 border-t border-border-soft pt-3"
            data-fleet-host-guidance=""
            aria-labelledby={id('-host-guidance-heading')}
          >
            <p className={EYEBROW} id={id('-host-guidance-heading')}>
              Changes from the host
            </p>
            {/* NOT 'only a terminal on the host may write fleet files' any more, and the correction
                matters: this browser is refused because it may not STAGE a change on this daemon, not
                because applying is a host-only act. Saying otherwise would send somebody to a terminal to
                work around a permission a different browser does not have. */}
            <p className="m-0 mt-1 text-meta leading-base text-muted">
              This browser may inspect this daemon and may not stage a change on it. The host itself always can. For a
              new fleet, run these commands there:
            </p>
            <pre className="m-0 mt-2 overflow-x-auto whitespace-pre rounded-control bg-surface-2 p-3 font-mono text-meta leading-base text-fg">
              {FIRST_ACCOUNT_COMMANDS}
            </pre>
            <p className="mb-0 mt-2 text-meta leading-base text-muted">
              Init creates only missing files. For an existing configuration, stage and apply the change from a Fleet
              panel this daemon lets stage one, or run it from a terminal on the host.
            </p>
          </section>
        )}
      </section>
    </section>
  );
}

/**
 * The mounted settings sub-tab, ready for the composition root's `daemonSettingsTabs` seam.
 *
 * Exported as a definition rather than mounted here, because the tab list lives in `App.tsx` and this
 * unit does not own that file. One line there mounts exactly this.
 */
export const fleetSettingsTab = (createClient: FleetClientFactory) =>
  ({
    id: 'fleet',
    label: 'Fleet',
    description: 'Accounts on this daemon host, and the exact change any edit would make.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <FleetConfigurationSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
