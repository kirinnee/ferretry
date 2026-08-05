/**
 * The daemon-bound fleet cockpit: one host, one authority, one staged change.
 *
 * IT OWNS NO MODULE CACHE AND NO CROSS-DAEMON STATE. A fleet belongs to a MACHINE and this browser can
 * be paired to several, so the whole session — client, evidence, draft, proposal, approval code and
 * result — is one value stamped with the connection it belongs to. Changing connection replaces that
 * value outright: a draft composed against one host must never be applied to another, and a result
 * from one host must never be read as this one's.
 *
 * A FAILED READ IS NOT AN EMPTY FLEET. Missing configuration, damaged configuration, a never-applied
 * host and a positively observed empty one each get their own state and their own sentence, decided by
 * `classifyInventory` from evidence rather than from absence.
 *
 * NOTHING IS PATCHED OPTIMISTICALLY. After an apply the manifest and configuration are re-read from
 * the daemon, including after a failure — a browser that edited its own list to match what it hoped
 * happened would be the most convincing possible lie about a host it cannot see.
 */

import { Layers3, Lock, Plus, ServerCog, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import { type DaemonConnection, sameDaemonConnection } from '../../lib/daemon-connection.ts';
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
  listFleetAssets,
  parseApprovalCode,
  readFleetAsset,
  readFleetConfig,
  readFleetManifest,
  readFleetPermissions,
  readFleetProposal,
} from './fleet-api.ts';
import { FleetAccountForm, FleetLayerForm, FleetProblems } from './fleet-change-forms.tsx';
import {
  accountProblems,
  approvalCommand,
  CHANGE_LIMITS,
  classifyInventory,
  createAccountProposal,
  declaredLayer,
  editAccountProposal,
  emptyAccountDraft,
  type FleetAccountDraft,
  type FleetAuthorityMode,
  type FleetInventory,
  type FleetLayerDraft,
  type FleetProbe,
  type FleetUnreadableAsset,
  fleetAuthority,
  harnessEvidence,
  initializeProposal,
  layerDraftFrom,
  layerProblems,
  mayComposeChange,
  mayInitialize,
  outcomeSummary,
  selectLayerAssets,
  unreadableAssetProblems,
} from './fleet-change-model.ts';
import { FleetApplyReport, FleetChangeReview, FleetLiveRoster, FleetRefusalAlert } from './fleet-change-review.tsx';
import { defaultFleetHarness } from './fleet-model.ts';

export type FleetClientFactory = (connection: DaemonConnection) => Promise<FleetClient>;

/** What the person is composing, if anything. */
type FleetComposeMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'create'; readonly draft: FleetAccountDraft }
  | {
      readonly kind: 'edit';
      readonly accountId: string;
      readonly wrapper: string;
      readonly layer: FleetLayerDraft;
      /** Assets this layer references whose current text the browser does not hold. Blocks staging. */
      readonly unreadable: readonly FleetUnreadableAsset[];
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
  readonly mode: FleetComposeMode;
  readonly proposal: FleetProposalView | null;
  readonly code: string;
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
  mode: { kind: 'idle' },
  proposal: null,
  code: '',
  refusal: null,
  outcome: null,
  busy: false,
});

/**
 * Is this refusal about a proposal the daemon no longer holds?
 *
 * Such a proposal can never be applied again, so wherever the surface learns it — an apply that was
 * refused, or a re-read while waiting for an approval — it must stop offering the change rather than
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

const AUTHORITY_COPY: Readonly<Record<FleetAuthorityMode, string>> = {
  direct: 'Host authority',
  approval: 'Approval required',
  'read-only': 'Read only',
};

/** The host-state verdict, in the header, in two words. The panel below says the rest. */
const STATE_BADGE: Readonly<Record<FleetInventory['kind'], { label: string; tone: string }>> = {
  live: { label: 'published', tone: 'ok' },
  uninitialized: { label: 'no fleet yet', tone: 'accent' },
  'not-applied': { label: 'not published', tone: 'warn' },
  damaged: { label: 'unreadable', tone: 'err' },
  forbidden: { label: 'refused', tone: 'err' },
  unreachable: { label: 'no answer', tone: 'err' },
};

const INVENTORY_COPY: Readonly<Record<Exclude<FleetInventory['kind'], 'live'>, { title: string; body: string }>> = {
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
  unreachable: {
    title: 'This daemon did not answer',
    body: 'The fleet read did not complete, so nothing about this host is known from here. It is not an empty fleet.',
  },
};

export interface FleetConfigurationSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient?: FleetClientFactory;
}

export function FleetConfigurationSurface({
  connection,
  createClient = daemonApiClient,
}: FleetConfigurationSurfaceProps) {
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
      if (!live) return;
      patch(generation, { client, permissions: permissions.ok ? permissions.value : null, ...evidence });
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
  const proposalId = session.proposal?.id ?? null;
  const outcomeKind = session.outcome?.outcome ?? null;
  useEffect(() => {
    if (proposalId !== null) reviewRef.current?.focus();
  }, [proposalId]);
  useEffect(() => {
    if (outcomeKind !== null) reportRef.current?.focus();
  }, [outcomeKind]);

  const stage = useCallback(
    async (request: FleetProposalRequest): Promise<void> => {
      if (client === null) return;
      patch(generation, { busy: true, refusal: null, outcome: null });
      try {
        patch(generation, { proposal: await createFleetProposal(client, request), code: '' });
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
   */
  const startEdit = useCallback(
    (account: FleetManifestAccountView): void => {
      const declared = layerDraftFrom(declaredLayer(session.config, account.id));
      const nothingToRead = declared.instructions.path === '' && declared.skillsDirectory === '';
      patch(generation, {
        mode: {
          kind: 'edit',
          accountId: account.id,
          wrapper: account.wrapper,
          layer: declared,
          unreadable: [],
          loading: client !== null && !nothingToRead,
        },
        proposal: null,
        outcome: null,
        refusal: null,
      });
      if (client === null || nothingToRead) return;

      void (async () => {
        const index = await probe(() => listFleetAssets(client));
        const selection = index.ok
          ? selectLayerAssets(index.value, declared.instructions.path, declared.skillsDirectory)
          : {
              readable: [],
              // A tree nobody could list is a tree whose contents are unknown, which is a blocker too.
              unreadable: [{ path: 'fleet/assets', reason: index.refusal.detail }],
            };
        const unreadable = [...selection.unreadable];
        let instructions = declared.instructions;
        const skills: { id: string; path: string; text: string }[] = [];
        for (const path of selection.readable) {
          const document = await probe(() => readFleetAsset(client, path));
          if (!document.ok) {
            unreadable.push({ path, reason: document.refusal.detail });
            continue;
          }
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
              loading: false,
            },
          };
        });
      })();
    },
    [client, generation, patch, session.config],
  );

  const apply = useCallback(async (): Promise<void> => {
    const proposal = session.proposal;
    if (client === null || proposal === null) return;
    const authority = fleetAuthority(session.permissions);
    let approvalCode: string | undefined;
    if (authority === 'approval') {
      const parsed = parseApprovalCode(session.code);
      if (parsed === null) {
        patch(generation, {
          refusal: {
            kind: 'proposal-unauthorized',
            detail:
              'That is not an approval code. A code is eight characters the host printed, such as 7F3K-M9QW; this one was not sent, so no attempt was spent.',
          },
        });
        return;
      }
      approvalCode = parsed;
    }
    patch(generation, { busy: true, refusal: null });
    try {
      const outcome = await applyFleetProposal(client, proposal.id, approvalCode);
      // Positive evidence, re-read. The list on screen is what the daemon holds, never what we hoped.
      patch(generation, { outcome, proposal: null, code: '', mode: { kind: 'idle' }, ...(await readEvidence(client)) });
    } catch (cause) {
      const refusal = fleetRefusal(cause);
      patch(generation, { refusal, ...(isDead(refusal) ? { proposal: null } : {}), ...(await readEvidence(client)) });
    } finally {
      patch(generation, { busy: false });
    }
  }, [client, generation, patch, readEvidence, session.code, session.permissions, session.proposal]);

  const recheck = useCallback(async (): Promise<void> => {
    const proposal = session.proposal;
    if (client === null || proposal === null) return;
    patch(generation, { busy: true, refusal: null });
    const read = await probe(() => readFleetProposal(client, proposal.id));
    if (read.ok) {
      patch(generation, { proposal: read.value, busy: false });
      return;
    }
    // The same retirement an apply performs. Learning here that the proposal is gone and then leaving
    // an enabled Apply button bound to its id would be the worst of both answers.
    patch(generation, {
      refusal: read.refusal,
      busy: false,
      ...(isDead(read.refusal) ? { proposal: null } : {}),
    });
  }, [client, generation, patch, session.proposal]);

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
  const authority = fleetAuthority(session.permissions);
  const live = inventory.kind === 'live' ? inventory.manifest.accounts : [];
  const composable = mayComposeChange(inventory) && session.permissions?.mayPropose === true;
  const variants = Object.keys(session.config?.variants ?? {});
  const suggestion = defaultFleetHarness(harnessEvidence(live));
  const composing = mode.kind !== 'idle' || session.proposal !== null;

  return (
    <section
      className="space-y-3"
      data-fleet-configuration=""
      data-fleet-daemon-id={String(connection.daemonId)}
      aria-labelledby="fleet-configuration-heading"
    >
      <p className="sr-only" role="status" data-fleet-announcement="">
        {session.busy
          ? 'Working…'
          : session.outcome === null
            ? session.proposal === null
              ? ''
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
              id="fleet-configuration-heading"
              className="m-0 font-display text-title font-bold tracking-display text-fg"
            >
              Fleet
            </h2>
            {/* WHICH HOST. A browser can be paired to several, and every path, wrapper and operation
                below belongs to exactly this one. */}
            <code className="block truncate font-mono text-meta text-muted">{String(connection.daemonId)}</code>
          </div>
          <span
            className="kt-badge"
            data-tone={STATE_BADGE[inventory.kind].tone}
            data-fleet-state-badge={inventory.kind}
          >
            {STATE_BADGE[inventory.kind].label}
          </span>
          <span
            className="kt-badge ml-auto"
            data-tone={authority === 'direct' ? 'ok' : authority === 'approval' ? 'accent' : 'warn'}
            data-fleet-authority-mode={authority}
          >
            {authority === 'direct' ? (
              <ShieldCheck size={12} aria-hidden="true" />
            ) : (
              <Lock size={12} aria-hidden="true" />
            )}
            {AUTHORITY_COPY[authority]}
          </span>
        </div>
        {composable && !composing ? (
          <div className="flex flex-wrap gap-2 px-panel py-3">
            <button
              type="button"
              className="kt-btn"
              data-variant="primary"
              data-fleet-start-create=""
              onClick={() =>
                patch(generation, {
                  mode: { kind: 'create', draft: emptyAccountDraft(suggestion ?? 'claude') },
                  outcome: null,
                  refusal: null,
                })
              }
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
          aria-labelledby="fleet-state-heading"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 shrink-0 text-warn">
              {inventory.kind === 'uninitialized' ? (
                <ServerCog size={18} aria-hidden="true" />
              ) : (
                <TriangleAlert size={18} aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h3 id="fleet-state-heading" className="m-0 text-title font-semibold text-fg">
                {INVENTORY_COPY[inventory.kind].title}
              </h3>
              <p className="mb-0 mt-1 text-ui leading-base text-muted">{INVENTORY_COPY[inventory.kind].body}</p>
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
      <div className={cn('grid min-w-0 gap-3', composing && 'xl:grid-cols-2')}>
        {inventory.kind === 'live' ? (
          <FleetLiveRoster
            accounts={live}
            generatedAt={inventory.manifest.generatedAt}
            onEdit={startEdit}
            editable={composable && session.proposal === null}
          />
        ) : null}

        {session.proposal !== null ? (
          <div ref={reviewRef} tabIndex={-1} className="min-w-0">
            <FleetChangeReview
              proposal={session.proposal}
              live={live}
              authority={authority}
              command={
                session.permissions === null
                  ? 'fy fleet authorize'
                  : approvalCommand(session.permissions, session.proposal.id)
              }
              code={session.code}
              onCodeChange={code => patch(generation, { code })}
              onApply={() => void apply()}
              onRecheck={() => void recheck()}
              onDiscard={() => patch(generation, { proposal: null, code: '', refusal: null })}
              busy={session.busy}
              refusal={session.refusal}
            />
          </div>
        ) : null}

        {session.proposal === null && mode.kind === 'create' ? (
          <div className="kt-panel overflow-hidden">
            <FleetAccountForm
              draft={mode.draft}
              onChange={draft => patch(generation, { mode: { kind: 'create', draft } })}
              onSubmit={() => void stage(createAccountProposal(mode.draft))}
              onCancel={() => patch(generation, { mode: { kind: 'idle' }, refusal: null })}
              problems={accountProblems(mode.draft, session.config)}
              disabled={session.busy}
              suggestion={suggestion}
              variants={variants.length === 0 ? ['default'] : variants}
            />
          </div>
        ) : null}

        {session.proposal === null && mode.kind === 'edit' ? (
          <div className="kt-panel overflow-hidden">
            <FleetLayerForm
              wrapper={mode.wrapper}
              layer={mode.layer}
              onChange={layer => patch(generation, { mode: { ...mode, layer } })}
              onSubmit={() => void stage(editAccountProposal(mode.accountId, mode.layer))}
              onCancel={() => patch(generation, { mode: { kind: 'idle' }, refusal: null })}
              problems={[...unreadableAssetProblems(mode.unreadable), ...layerProblems(mode.layer)]}
              disabled={session.busy || mode.loading}
              loading={mode.loading}
            />
          </div>
        ) : null}
      </div>

      <section className="kt-panel px-panel py-3" aria-labelledby="fleet-limits-heading">
        <p className="kt-label m-0" id="fleet-limits-heading">
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
