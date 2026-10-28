/**
 * SETTINGS › MACHINE › ABOUT: what this machine runs, how it was installed, and getting it up to date.
 *
 * The daemon answers everything here (`GET /v1/daemon/update`, `docs/updating.md`): its version, how it
 * was installed, the latest release it knows of, and what updating takes. This panel only draws that
 * answer and sends the three requests a person can make — Update, Update when idle, and the
 * automatic-install switch. A remote device's update needs a passkey; the app's carrier asks for it on
 * the daemon's `403 grant_step_up_required` and retries, exactly as for every other governed act, so
 * nothing here knows passkeys exist.
 *
 * FERRETS MID-TURN DO NOT BLOCK AN UPDATE. They run outside the daemon and their Ferretry calls wait for
 * it to come back, so Update goes ahead with one line saying so; Update when idle is there for whoever
 * would rather wait. Every `now` still carries `confirmMidTurn`, because a machine from before this
 * change refuses a mid-turn update without it.
 *
 * THE RESTART IS EXPECTED. An update restarts the daemon that answered it, so the reads that follow can
 * fail for a few seconds. While an update runs, a failed read keeps the last view on screen and says
 * "restarting"; it is only a failure once nothing is running.
 */

import type { DaemonUpdateView, IFyApiClient } from '@ferretry/protocol';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { appVersion } from '../../lib/app-version.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Badge, Button } from '../../shell/primitives.tsx';
import { useWhatsNewEntry } from '../whats-new/whats-new-host.tsx';
import { CommandBlock } from '../onboarding/command-block.tsx';
import { browserClipboardWriter, type ClipboardWriter } from '../onboarding/copy-button.tsx';
import {
  changelogRelease,
  checkWords,
  installWords,
  isMissingRoute,
  jobWords,
  keepRunningWords,
  refusalWords,
  shouldPoll,
  updateHeadline,
  versionPairWords,
} from './about-machine-model.ts';

/** How often the panel re-reads while an update is waiting or running. */
export const ABOUT_POLL_MS = 3_000;

export type AboutClient = Pick<IFyApiClient, 'daemonUpdate' | 'startDaemonUpdate' | 'updateDaemonUpdateSettings'>;
export type AboutClientFactory = (connection: DaemonConnection) => Promise<AboutClient>;

export interface AboutMachinePanelProps {
  readonly view: DaemonUpdateView;
  /** The app's own version, or `undefined` for a build that was stamped with none. */
  readonly appVersion: string | undefined;
  readonly now: number;
  /** A request is in flight; every control waits for it. */
  readonly busy: boolean;
  /** The machine is restarting into an update and has not answered yet. */
  readonly restarting: boolean;
  /** The daemon's sentence for the last request it refused. */
  readonly refusal: string | null;
  readonly onUpdate: (choice: 'now' | 'when-idle') => void;
  readonly onAutoInstall: (next: boolean) => void;
  readonly write: ClipboardWriter;
}

const TONE_CLASS = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  pend: 'text-muted',
} as const;

function Steps({ view, write }: { readonly view: DaemonUpdateView; readonly write: ClipboardWriter }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0" data-about-steps={view.plan.kind}>
      {view.plan.steps.map((step, index) => (
        <li key={step.command} className="flex min-w-0 flex-col gap-1">
          <CommandBlock command={step.command} copyLabel={`Copy step ${String(index + 1)}`} write={write} />
          {step.note === undefined ? null : <p className="m-0 text-meta leading-base text-faint">{step.note}</p>}
        </li>
      ))}
    </ol>
  );
}

/** What updating takes for this install method: a button, a switch to explain, or steps. */
function UpdateAction({
  view,
  busy,
  restarting,
  write,
  onUpdate,
}: Pick<AboutMachinePanelProps, 'view' | 'busy' | 'restarting' | 'write' | 'onUpdate'>) {
  const plan = view.plan;
  if (plan.kind === 'self') {
    if (!view.available) return null;
    const pending = view.job !== null && view.job.state !== 'finished';
    const disabled = busy || pending || restarting;
    return (
      <div className="flex min-w-0 flex-col gap-2" data-about-self="">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={disabled}
            data-about-update=""
            onClick={() => onUpdate('now')}
          >
            {restarting ? 'Restarting…' : 'Update'}
          </Button>
          {view.midTurn > 0 && !pending ? (
            <Button
              type="button"
              disabled={disabled}
              data-about-update-when-idle=""
              onClick={() => onUpdate('when-idle')}
            >
              Update when idle
            </Button>
          ) : null}
        </div>
        {view.midTurn > 0 && !pending ? (
          <p className="m-0 text-cell leading-base text-muted" data-about-mid-turn={String(view.midTurn)}>
            {keepRunningWords(view.midTurn)}
          </p>
        ) : null}
        <p className="m-0 text-meta leading-base text-faint">
          {plan.rollback === 'automatic'
            ? 'If the new version does not come up, the old one is put back on its own.'
            : 'This install method keeps no previous version, so a failed update cannot be undone on its own.'}
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-about-plan={plan.kind}>
      {plan.kind === 'switch' ? (
        <p className="m-0 text-cell font-semibold text-fg">Switch to a nix profile install (at the machine)</p>
      ) : null}
      <p className="m-0 text-cell leading-base text-muted">{plan.explanation}</p>
      {plan.kind === 'switch' ? (
        <p className="m-0 text-meta leading-base text-faint">
          Nothing changes until you run these, or <code>fy daemon update --switch-to-profile</code>, on the machine.
        </p>
      ) : null}
      <Steps view={view} write={write} />
    </div>
  );
}

/** The panel, drawn from one view. Every request goes out through the callbacks. */
export function AboutMachinePanel({
  view,
  appVersion: app,
  now,
  busy,
  restarting,
  refusal,
  onUpdate,
  onAutoInstall,
  write,
}: AboutMachinePanelProps) {
  const install = installWords(view);
  const pair = versionPairWords(app, view.current);
  const release = changelogRelease(view);
  const whatsNew = useWhatsNewEntry();
  const job = view.job === null ? null : jobWords(view.job);
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel" aria-labelledby="about-machine-heading">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="about-machine-heading" className="m-0 text-row font-semibold text-fg">
            {updateHeadline(view)}
          </h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{checkWords(view.check, now)}</p>
        </div>
        {view.available ? <Badge tone="accent">Update available</Badge> : null}
      </div>

      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-cell">
        <dt className="text-muted">Machine</dt>
        <dd className="m-0 min-w-0 text-fg" data-about-daemon-version="">
          {view.current}
        </dd>
        <dt className="text-muted">This app</dt>
        <dd className="m-0 min-w-0 text-fg" data-about-app-version="">
          {app ?? 'unknown'}
        </dd>
        <dt className="text-muted">Installed with</dt>
        <dd className="m-0 min-w-0 break-words text-fg" title={install.detail} data-about-method={view.method.kind}>
          {install.label}
          <span className="block text-meta text-faint">{install.detail}</span>
        </dd>
      </dl>

      <p
        role={pair.tone === 'warn' ? 'alert' : undefined}
        className={cn('m-0 text-cell leading-base', TONE_CLASS[pair.tone])}
        data-about-version-pair={pair.tone}
      >
        {pair.text}
      </p>

      {whatsNew === null ? (
        release === undefined ? null : (
          <a
            className="inline-flex min-h-[44px] w-fit items-center gap-1 text-cell text-accent underline"
            href={release.url}
            target="_blank"
            rel="noreferrer noopener"
            data-about-changelog=""
          >
            What’s new in {release.version}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <Button size="sm" className="min-h-[44px]" onClick={whatsNew.open} data-about-whats-new="">
            <Sparkles size={13} aria-hidden="true" />
            What’s new
            {whatsNew.unread ? (
              <Badge tone="accent" data-about-whats-new-unread="">
                New
              </Badge>
            ) : null}
          </Button>
          {release === undefined ? null : (
            <a
              className="inline-flex min-h-[44px] items-center gap-1 text-cell text-muted underline"
              href={release.url}
              target="_blank"
              rel="noreferrer noopener"
              data-about-changelog=""
            >
              Full release on GitHub
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      {job === null ? null : (
        <p role="status" className={cn('m-0 text-cell leading-base', TONE_CLASS[job.tone])} data-about-job="">
          {job.text}
        </p>
      )}

      <UpdateAction view={view} busy={busy} restarting={restarting} write={write} onUpdate={onUpdate} />
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-about-error="">
          {refusal}
        </p>
      )}

      {view.plan.kind === 'self' ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border-strong pt-3">
          <div className="min-w-0">
            <p className="m-0 text-cell font-semibold text-fg">Install updates automatically when idle</p>
            <p className="m-0 text-meta leading-base text-faint">
              Off unless you turn it on. Only starts when no ferret is mid-turn.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={view.autoInstall}
            aria-label="Install updates automatically when idle"
            disabled={busy}
            onClick={() => onAutoInstall(!view.autoInstall)}
            className="flex min-h-[44px] items-center gap-sm rounded-control px-control-x text-ui font-semibold text-fg"
            data-about-auto-install=""
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
                view.autoInstall ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
              )}
            >
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
                  view.autoInstall ? 'translate-x-[18px]' : 'translate-x-[2px]',
                )}
              />
            </span>
            {view.autoInstall ? 'On' : 'Off'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'view'; readonly view: DaemonUpdateView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface AboutMachineSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient?: AboutClientFactory;
  /** Seams for tests and the harness. */
  readonly pollMs?: number;
  readonly clock?: () => number;
  readonly write?: ClipboardWriter;
}

/** The panel bound to one machine: reads its view, re-reads while an update runs, and sends requests. */
export function AboutMachineSurface({
  connection,
  createClient: injected,
  pollMs = ABOUT_POLL_MS,
  clock = Date.now,
  write = browserClipboardWriter(),
}: AboutMachineSurfaceProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [client, setClient] = useState<AboutClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Bumped after every poll, answered or not, so the next one is scheduled.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded({ kind: 'loading' });
    void createClient(connection)
      .then(async next => {
        const view = await next.daemonUpdate();
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
  const polling = client !== null && view !== null && (restarting || shouldPoll(view));
  useEffect(() => {
    void tick;
    if (!polling || client === null) return;
    let current = true;
    const timer = setTimeout(() => {
      void client
        .daemonUpdate()
        .then(next => {
          if (!current) return;
          setLoaded({ kind: 'view', view: next });
          if (!shouldPoll(next)) setRestarting(false);
          setTick(count => count + 1);
        })
        // The machine is restarting into the update: keep the last view and ask again next tick.
        .catch(() => {
          if (current) setTick(count => count + 1);
        });
    }, pollMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, polling, pollMs, tick]);

  const act = useCallback(
    async (work: (active: AboutClient) => Promise<DaemonUpdateView>, starting: boolean) => {
      if (client === null) return;
      setBusy(true);
      setRefusal(null);
      try {
        const next = await work(client);
        setLoaded({ kind: 'view', view: next });
        if (starting && next.job?.state === 'running') setRestarting(true);
      } catch (cause) {
        setRefusal(refusalWords(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  if (loaded.kind === 'loading')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading about this machine">
        <p className="m-0 text-ui text-faint">Reading what this machine runs…</p>
      </section>
    );
  if (loaded.kind === 'missing')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Updates unavailable" data-about-missing="">
        <h3 className="m-0 text-row font-semibold text-fg">This machine cannot check for updates yet</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          It runs a Ferretry from before update checks. Update it once with the package manager you installed it with
          and restart it; after that it says here when a newer version exists.
        </p>
      </section>
    );
  if (loaded.kind === 'failed')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="About this machine unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">About this machine unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read what this machine runs: {loaded.reason}
        </p>
      </section>
    );

  const target = changelogRelease(loaded.view)?.version ?? loaded.view.current;
  return (
    <AboutMachinePanel
      view={loaded.view}
      appVersion={appVersion()}
      now={clock()}
      busy={busy}
      restarting={restarting}
      refusal={refusal}
      write={write}
      onUpdate={choice =>
        void act(
          active =>
            active.startDaemonUpdate(
              choice === 'when-idle' ? { target, when: 'when-idle' } : { target, when: 'now', confirmMidTurn: true },
            ),
          true,
        )
      }
      onAutoInstall={next => void act(active => active.updateDaemonUpdateSettings({ autoInstall: next }), false)}
    />
  );
}

/** The Settings › Machine row, supplied through the frame's `additionalTabs` seam. */
export const aboutSettingsTab = (createClient?: AboutClientFactory) =>
  ({
    id: 'about',
    label: 'About & updates',
    description: 'This machine’s version, how it was installed, and updating it.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <AboutMachineSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
