/**
 * SETTINGS › MACHINE › AGENT CLIs: which `claude` and `codex` this machine's ferrets run, how each was
 * installed, whether Ferretry has verified that version, and updating each one.
 *
 * The daemon answers everything (`GET /v1/harnesses/update`, `docs/updating.md`), and opening this panel
 * is what makes it ask npm for the newest versions — there is no timer. This panel draws that answer and
 * sends one request: Update. Going past the version Ferretry verified takes an explicit second yes, and
 * a remote device's update needs a passkey, which the app's carrier asks for on the daemon's `403
 * grant_step_up_required` exactly as for every other governed act.
 *
 * An update replaces the binary; it restarts nothing. Running ferrets keep the version they started
 * with until they are restarted, and the panel says so.
 */

import type {
  Harness,
  HarnessCliView,
  HarnessUpdateStartRequest,
  HarnessUpdateView,
  IFyApiClient,
} from '@ferretry/protocol';
import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Badge, Button } from '../../shell/primitives.tsx';
import { CommandBlock } from '../onboarding/command-block.tsx';
import { browserClipboardWriter, type ClipboardWriter } from '../onboarding/copy-button.tsx';
import { isMissingRoute } from './about-machine-model.ts';
import {
  anyCliUpdate,
  type CliStartRefusal,
  cliHeadline,
  cliJobWords,
  cliStartRefusal,
  installWords,
  latestWords,
  locationWords,
  shouldPollClis,
  type UpdateChoice,
  unverifiedQuestion,
  updateChoices,
  verificationBadge,
} from './agent-clis-model.ts';

/** How often the panel re-reads while an update runs. */
export const AGENT_CLIS_POLL_MS = 2_000;

export type AgentClisClient = Pick<IFyApiClient, 'harnessUpdate' | 'startHarnessUpdate'>;
export type AgentClisClientFactory = (connection: DaemonConnection) => Promise<AgentClisClient>;

/** A press waiting for its second yes. */
export interface AgentCliPendingConfirm {
  readonly harness: Harness;
  readonly target?: string;
}

export interface AgentClisPanelProps {
  readonly view: HarnessUpdateView;
  readonly now: number;
  /** The harness whose request is in flight. */
  readonly busy: Harness | null;
  readonly confirming: AgentCliPendingConfirm | null;
  readonly refusals: Readonly<Partial<Record<Harness, CliStartRefusal>>>;
  readonly onChoose: (harness: Harness, choice: UpdateChoice) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly write: ClipboardWriter;
}

const TONE_CLASS = { ok: 'text-ok', warn: 'text-warn', err: 'text-err', pend: 'text-muted' } as const;

function Row({
  term,
  children,
  detail,
}: {
  readonly term: string;
  readonly children: string;
  readonly detail?: string;
}) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className="m-0 min-w-0 break-words text-fg">
        {children}
        {detail === undefined ? null : <span className="block text-meta text-faint">{detail}</span>}
      </dd>
    </>
  );
}

function ConfirmUnverified({
  view,
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly view: HarnessCliView;
  readonly target: string | undefined;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <fieldset
      aria-label="Not yet verified by Ferretry"
      className="m-0 flex min-w-0 flex-col gap-2 rounded-control border border-warn-border bg-warn-bg p-3"
      data-agent-cli-confirm={view.harness}
    >
      <p className="m-0 text-cell leading-base text-fg">{unverifiedQuestion(view, target)}</p>
      <a
        className="inline-flex min-h-[44px] w-fit items-center gap-1 text-cell text-accent underline"
        href={view.verified.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        What Ferretry verifies, and the known risks
        <ExternalLink size={13} aria-hidden="true" />
      </a>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="danger" disabled={busy} onClick={onConfirm} data-agent-cli-confirm-yes="">
          Update anyway
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

function UpdateArea({ view, props }: { readonly view: HarnessCliView; readonly props: AgentClisPanelProps }) {
  const plan = view.plan;
  if (plan === null) return null;
  if (plan.kind === 'manual')
    return (
      <div className="flex min-w-0 flex-col gap-2" data-agent-cli-plan="manual">
        <p className="m-0 text-cell leading-base text-muted">{plan.explanation}</p>
        {plan.steps.length === 0 ? null : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {plan.steps.map((step, index) => (
              <li key={step.command} className="flex min-w-0 flex-col gap-1">
                <CommandBlock
                  command={step.command}
                  copyLabel={`Copy ${view.harness} step ${String(index + 1)}`}
                  write={props.write}
                />
                {step.note === undefined ? null : <p className="m-0 text-meta leading-base text-faint">{step.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  const busy = props.busy !== null;
  const running = view.job?.state === 'running';
  const choices = updateChoices(view);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-agent-cli-plan="self">
      {choices.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {choices.map(choice => (
            <Button
              key={choice.key}
              type="button"
              variant={choice.primary ? 'primary' : 'outline'}
              disabled={busy || running}
              onClick={() => props.onChoose(view.harness, choice)}
              data-agent-cli-update={`${view.harness}:${choice.key}`}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      <p className="m-0 text-meta leading-base text-faint">
        Runs {plan.steps.map(step => step.command).join(', then ')}.{' '}
        {plan.rollback === 'automatic'
          ? 'If the new version does not start, the old one is put back.'
          : 'This install method keeps no previous version, so a failed update cannot be undone on its own.'}
      </p>
    </div>
  );
}

function HarnessCard({ view, props }: { readonly view: HarnessCliView; readonly props: AgentClisPanelProps }) {
  const badge = verificationBadge(view.verification);
  const install = installWords(view);
  const job = view.job === null ? null : cliJobWords(view.job);
  const refusal = props.refusals[view.harness];
  const confirming = props.confirming?.harness === view.harness ? props.confirming : null;
  const located = view.location.state === 'located';
  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border-strong p-3"
      aria-labelledby={`agent-cli-${view.harness}-heading`}
      data-agent-cli={view.harness}
      data-agent-cli-method={view.method?.kind ?? 'none'}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4 id={`agent-cli-${view.harness}-heading`} className="m-0 text-row font-semibold text-fg">
          {cliHeadline(view)}
        </h4>
        <div className="flex flex-wrap items-center gap-1">
          {located ? (
            <Badge tone={badge.tone} data-agent-cli-verification={view.verification}>
              {badge.text}
            </Badge>
          ) : (
            <Badge tone="err">Not found</Badge>
          )}
          {view.available ? (
            <Badge tone="accent" data-agent-cli-available="">
              Update available
            </Badge>
          ) : null}
        </div>
      </div>

      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-cell">
        <Row term="Runs" detail={locationWords(view.location)}>
          {view.location.state === 'absent' ? 'nothing' : view.location.path}
        </Row>
        {install === undefined ? null : (
          <Row term="Installed with" detail={install.detail}>
            {install.label}
          </Row>
        )}
        {view.installed?.state === 'unreadable' ? (
          <Row term="Version">{`unreadable — ${view.installed.reason}`}</Row>
        ) : null}
        <Row term="Verified">{view.verified.version}</Row>
        {located ? <Row term="Latest">{latestWords(view.check, props.now)}</Row> : null}
      </dl>

      {view.verification === 'unverified' ? (
        <p className="m-0 text-cell leading-base text-warn" data-agent-cli-unverified-note="">
          This version is newer than the one Ferretry verified.{' '}
          <a className="text-accent underline" href={view.verified.url} target="_blank" rel="noreferrer noopener">
            Known risks
          </a>
        </p>
      ) : null}

      {job === null ? null : (
        <p role="status" className={cn('m-0 text-cell leading-base', TONE_CLASS[job.tone])} data-agent-cli-job="">
          {job.text}
        </p>
      )}

      {confirming === null ? (
        <UpdateArea view={view} props={props} />
      ) : (
        <ConfirmUnverified
          view={view}
          target={confirming.target}
          busy={props.busy !== null}
          onConfirm={props.onConfirm}
          onCancel={props.onCancel}
        />
      )}
      {refusal?.kind === 'message' ? (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-agent-cli-error="">
          {refusal.text}
        </p>
      ) : null}
    </article>
  );
}

/** The panel, drawn from one view. Every request goes out through the callbacks. */
export function AgentClisPanel(props: AgentClisPanelProps) {
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel" aria-labelledby="agent-clis-heading">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="agent-clis-heading" className="m-0 text-row font-semibold text-fg">
            Agent CLIs
          </h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            The Claude Code and Codex this machine’s ferrets run. Updating one replaces it for new ferrets; running
            ferrets keep their current version until they are restarted.
          </p>
        </div>
        {anyCliUpdate(props.view) ? <Badge tone="accent">Update available</Badge> : null}
      </div>
      {props.view.harnesses.map(harness => (
        <HarnessCard key={harness.harness} view={harness} props={props} />
      ))}
    </section>
  );
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'view'; readonly view: HarnessUpdateView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface AgentClisSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient?: AgentClisClientFactory;
  /** Seams for tests and the harness. */
  readonly pollMs?: number;
  readonly clock?: () => number;
  readonly write?: ClipboardWriter;
}

/** The panel bound to one machine: reads its view on open, re-reads while an update runs, sends Update. */
export function AgentClisSurface({
  connection,
  createClient: injected,
  pollMs = AGENT_CLIS_POLL_MS,
  clock = Date.now,
  write = browserClipboardWriter(),
}: AgentClisSurfaceProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [client, setClient] = useState<AgentClisClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState<Harness | null>(null);
  const [confirming, setConfirming] = useState<AgentCliPendingConfirm | null>(null);
  const [refusals, setRefusals] = useState<Partial<Record<Harness, CliStartRefusal>>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded({ kind: 'loading' });
    void createClient(connection)
      .then(async next => {
        const view = await next.harnessUpdate();
        if (!current) return;
        setClient(next);
        setLoaded({ kind: 'view', view });
      })
      .catch((cause: unknown) => {
        if (current)
          setLoaded(isMissingRoute(cause) ? { kind: 'missing' } : { kind: 'failed', reason: reasonOf(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const view = loaded.kind === 'view' ? loaded.view : null;
  const polling = client !== null && view !== null && shouldPollClis(view);
  useEffect(() => {
    void tick;
    if (!polling || client === null) return;
    let current = true;
    const timer = setTimeout(() => {
      void client
        .harnessUpdate()
        .then(next => {
          if (current) setLoaded({ kind: 'view', view: next });
        })
        .catch(() => undefined)
        .finally(() => {
          if (current) setTick(count => count + 1);
        });
    }, pollMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, polling, pollMs, tick]);

  const send = useCallback(
    async (request: HarnessUpdateStartRequest) => {
      if (client === null) return;
      setBusy(request.harness);
      setRefusals(previous => ({ ...previous, [request.harness]: undefined }));
      try {
        setLoaded({ kind: 'view', view: await client.startHarnessUpdate(request) });
        setConfirming(null);
      } catch (cause) {
        const refusal = cliStartRefusal(cause);
        if (refusal.kind === 'unverified')
          setConfirming({
            harness: request.harness,
            ...(refusal.target === undefined ? {} : { target: refusal.target }),
          });
        else {
          setConfirming(null);
          setRefusals(previous => ({ ...previous, [request.harness]: refusal }));
        }
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  if (loaded.kind === 'loading')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading the agent CLIs">
        <p className="m-0 text-ui text-faint">
          Reading which agent CLIs this machine runs, and checking for newer ones…
        </p>
      </section>
    );
  if (loaded.kind === 'missing')
    return (
      <section
        className="kt-panel p-panel"
        role="status"
        aria-label="Agent CLIs unavailable"
        data-agent-clis-missing=""
      >
        <h3 className="m-0 text-row font-semibold text-fg">This machine cannot report its agent CLIs yet</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          It runs a Ferretry from before this panel. Update the machine (About & updates) and this shows which Claude
          Code and Codex it runs.
        </p>
      </section>
    );
  if (loaded.kind === 'failed')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Agent CLIs unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Agent CLIs unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read which agent CLIs this machine runs: {loaded.reason}
        </p>
      </section>
    );

  return (
    <AgentClisPanel
      view={loaded.view}
      now={clock()}
      busy={busy}
      confirming={confirming}
      refusals={refusals}
      write={write}
      onChoose={(harness, choice) => {
        const request = { harness, ...(choice.target === undefined ? {} : { target: choice.target }) };
        if (choice.unverified) setConfirming(request);
        else void send(request);
      }}
      onConfirm={() => {
        if (confirming !== null) void send({ ...confirming, confirmUnverified: true });
      }}
      onCancel={() => setConfirming(null)}
    />
  );
}

/** The Settings › Machine row, supplied through the frame's `additionalTabs` seam. */
export const agentClisSettingsTab = (createClient?: AgentClisClientFactory) =>
  ({
    id: 'agent-clis',
    label: 'Agent CLIs',
    description: 'The Claude Code and Codex this machine runs, whether Ferretry verified them, and updating them.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <AgentClisSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
