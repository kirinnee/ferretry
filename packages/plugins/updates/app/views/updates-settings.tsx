/**
 * Settings › Updates: how this daemon was installed, whether it is behind, and the update. The same view `fy update`
 * prints, so a terminal and a phone cannot disagree. Turning on automatic installs is a loosening the owner confirms:
 * the daemon answers `202` with the sentence and the switch stays off until then.
 */

import { Badge, Button, SettingGroup, SettingRow, SettingSwitch, useAppVersion, viewerTime } from '@ferretry/app';
import { Loading } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import {
  type DaemonUpdateSettingsHeld,
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
  describeInstallMethod,
  knownLatestRelease,
} from '../../contract/index.ts';
import {
  appStanding,
  appStandingWords,
  headlineSentence,
  refusalSentence,
  updateOffer,
  updateRequest,
} from '../lib/behind.ts';
import { pollUpdateStatus } from '../lib/poll-status.ts';

export const createSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function UpdatesSettings() {
    const appVersion = useAppVersion();
    const [view, setView] = useState<DaemonUpdateView | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [readError, setReadError] = useState<string | null>(null);
    useEffect(
      () =>
        pollUpdateStatus({
          read: async () => DaemonUpdateViewSchema.parse(await client.call('GET /v1/daemon/update')),
          view: next => {
            setView(next);
            setReadError(null);
          },
          failed: cause => setReadError(cause instanceof Error ? cause.message : 'The update state could not be read.'),
          later: (work, milliseconds) => {
            const timer = setTimeout(work, milliseconds);
            return () => clearTimeout(timer);
          },
        }),
      [],
    );

    const start = async (target: string, when: 'now' | 'when-idle'): Promise<void> => {
      setNote(null);
      try {
        setView(
          DaemonUpdateViewSchema.parse(
            await client.call('POST /v1/daemon/update', { body: updateRequest(target, when) }),
          ),
        );
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        setNote(refusalSentence(code, cause instanceof Error ? cause.message : 'The update could not start.'));
      }
    };
    const setAutoInstall = async (autoInstall: boolean): Promise<void> => {
      setNote(null);
      try {
        const answer = await client.call<DaemonUpdateView | DaemonUpdateSettingsHeld>(
          'PATCH /v1/daemon/update/settings',
          { body: { autoInstall } },
        );
        if ('held' in answer) {
          setView(DaemonUpdateViewSchema.parse(answer.view));
          setNote(`Waiting for your confirmation: ${answer.held.join('; ')}.`);
        } else setView(DaemonUpdateViewSchema.parse(answer));
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : 'The setting could not be changed.');
      }
    };

    if (view === null)
      return readError === null ? (
        <Loading kind="page" label="Reading the update state…" />
      ) : (
        <p role="status">{readError}</p>
      );
    return (
      <UpdatesView
        view={view}
        appVersion={appVersion}
        note={note}
        readError={readError}
        onStart={(target, when) => void start(target, when)}
        onAutoInstall={next => void setAutoInstall(next)}
      />
    );
  };

export interface UpdatesViewProps {
  readonly view: DaemonUpdateView;
  /** The build this browser runs; `undefined` where the page cannot say. */
  readonly appVersion?: string | undefined;
  readonly note: string | null;
  readonly readError: string | null;
  readonly onStart: (target: string, when: 'now' | 'when-idle') => void;
  readonly onAutoInstall: (next: boolean) => void;
}

/** The status badge beside the version: behind, up to date, or honestly unknown. */
function statusBadge(view: DaemonUpdateView): { readonly tone: 'ok' | 'warn' | 'pend'; readonly text: string } {
  if (view.available) return { tone: 'warn', text: 'Update available' };
  if (view.check.state === 'ok') return { tone: 'ok', text: 'Up to date' };
  return { tone: 'pend', text: view.check.state === 'never' ? 'Not checked' : 'Check failed' };
}

/** When the last check ran, in the reader's own clock; a daemon that has never checked says so. */
function lastCheckedWords(check: DaemonUpdateView['check']): string {
  if (check.state === 'never') return 'Not checked yet';
  const stamp = viewerTime(check.checkedAt);
  return check.state === 'failed' ? `${stamp} — the check failed` : stamp;
}

/** Settings › Updates, drawn from the daemon's own view: what runs, how it was installed, what is newer, and the switch. */
export function UpdatesView({ view, appVersion, note, readError, onStart, onAutoInstall }: UpdatesViewProps) {
  const offer = updateOffer(view);
  const badge = statusBadge(view);
  const latest = knownLatestRelease(view.check);
  const app = appStandingWords(appStanding(appVersion, view.current));
  return (
    <section
      aria-label="Updates"
      className="flex min-w-0 flex-col [&_[data-setting-hint]]:overflow-visible [&_[data-setting-hint]]:whitespace-normal [&_[data-setting-hint]]:[text-overflow:clip]"
    >
      <SettingGroup label="This machine">
        <SettingRow
          name="Version"
          hint={`Installed via ${describeInstallMethod(view.method)}`}
          control={() => <span className="text-ui font-semibold text-fg">{view.current}</span>}
        />
        <SettingRow
          name="Status"
          hint={headlineSentence(view)}
          control={() => <Badge tone={badge.tone}>{badge.text}</Badge>}
        />
        <SettingRow
          name="Newest release"
          hint={`Last checked: ${lastCheckedWords(view.check)}`}
          control={() => <span className="text-ui text-fg">{latest === undefined ? 'Unknown' : latest.version}</span>}
        />
        {offer.kind === 'busy' ? <SettingRow name="Updating" hint={offer.sentence} /> : null}
        {offer.kind === 'update' ? (
          <SettingRow
            name={`Update to ${offer.target}`}
            hint={
              offer.midTurn > 0
                ? `${offer.midTurn} mid-turn now; they keep running through the restart.`
                : 'Running ferrets keep running through the restart.'
            }
            wide
            control={() => (
              <span className="flex min-w-0 max-w-full flex-wrap gap-2 max-md:[&>button]:w-full [&>button]:h-auto [&>button]:max-w-full [&>button]:whitespace-normal">
                <Button variant="primary" onClick={() => onStart(offer.target, 'now')}>
                  Update to {offer.target}
                </Button>
                <Button onClick={() => onStart(offer.target, 'when-idle')}>Update when no ferret is mid-turn</Button>
              </span>
            )}
          />
        ) : null}
        {offer.kind === 'steps' ? (
          <SettingRow name="To update" hint={offer.explanation}>
            <ol className="m-0 flex flex-col gap-1 px-panel pb-3 pl-8 text-cell text-fg">
              {offer.steps.map(step => (
                <li key={step.command}>
                  <code>{step.command}</code>
                  {step.note === undefined ? null : <span className="text-muted"> — {step.note}</span>}
                </li>
              ))}
            </ol>
          </SettingRow>
        ) : null}
        {view.job?.state === 'finished' ? <SettingRow name="Last update" hint={view.job.report.message} /> : null}
      </SettingGroup>
      <SettingGroup label="This app">
        <SettingRow
          name="Version"
          hint="The build running in this browser"
          control={() => <span className="text-ui font-semibold text-fg">{appVersion ?? 'Unknown'}</span>}
        />
        <SettingRow name="Match" hint={app.hint} control={() => <Badge tone={app.tone}>{app.text}</Badge>} />
      </SettingGroup>
      <SettingGroup label="Automatic updates">
        <SettingRow
          name="Install updates automatically"
          hint="Only when no ferret is mid-turn"
          control={labelId => (
            <SettingSwitch checked={view.autoInstall} labelledBy={labelId} onChange={onAutoInstall} />
          )}
        >
          {/* Said under the row, not behind an (i) at the far edge: the switch sits beside its name with no dead gap. */}
          <p className="m-0 pb-3 pl-panel pr-1 text-cell leading-base text-muted">
            {view.plan.kind === 'self'
              ? view.plan.rollback === 'automatic'
                ? 'If the new version does not come up, the old one is put back.'
                : 'This install method keeps no previous version, so a failed update cannot be undone on its own.'
              : 'This install is updated by hand, so there is nothing to install automatically.'}
          </p>
        </SettingRow>
      </SettingGroup>
      {note === null ? null : (
        <p className="m-0 px-1 text-ui text-fg" role="status">
          {note}
        </p>
      )}
      {readError === null ? null : (
        <p className="m-0 px-1 text-ui text-fg" role="status">
          {readError}
        </p>
      )}
    </section>
  );
}
