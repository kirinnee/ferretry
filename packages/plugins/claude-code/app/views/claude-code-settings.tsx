/**
 * Settings › Claude Code: where claude is, how it was installed, its version, whether Ferretry verified it, and the
 * update. The same daemon view `fy harness claude-code status` prints, so a terminal and a phone cannot disagree.
 */

import { Badge, Button, SettingGroup, SettingRow, viewerTime } from '@ferretry/app';
import { Dialog, Loading } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import type { HarnessCliView, HarnessUpdateStartRequest } from '../../contract/index.ts';

/** How it was installed, in words a person reads (the daemon's own name for it is a code). */
const METHOD_WORDS: Readonly<Record<string, string>> = {
  'npm-global': 'npm global package',
  homebrew: 'Homebrew',
  'nix-profile': 'Nix profile',
  'nix-shell': 'Nix shell',
  'nix-module': 'Nix module',
  'native-installer': 'Native installer',
  standalone: 'Standalone binary',
  unknown: 'Unknown',
};

/** When the last check ran, in the reader's own clock (the raw instant when it cannot be read). */
const checkedWords = (instant: string): string => {
  return viewerTime(instant);
};

/** Numeric order of two stable x.y.z versions (what the daemon's own comparison reads for a release). */
const versionOrder = (a: string, b: string): number => {
  const left = a.split(/[-+]/u)[0]?.split('.').map(Number) ?? [];
  const right = b.split(/[-+]/u)[0]?.split('.').map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** The newest version the last check learned of (a failed check keeps the last good answer), or `undefined`. */
const knownLatest = (view: HarnessCliView): string | undefined =>
  view.check.state === 'ok'
    ? view.check.latest.version
    : view.check.state === 'failed'
      ? view.check.lastKnown?.latest.version
      : undefined;

export const createSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function ClaudeCodeSettings() {
    const [view, setView] = useState<HarnessCliView | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const read = useCallback(async () => {
      try {
        setView(await client.call<HarnessCliView>('GET /v1/claude-code/update'));
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : 'Claude Code could not be read.');
      }
    }, []);
    useEffect(() => {
      void read();
    }, [read]);
    const update = async (body: HarnessUpdateStartRequest): Promise<void> => {
      setNote(null);
      try {
        setView(await client.call<HarnessCliView>('POST /v1/claude-code/update', { body }));
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : 'The update could not be started.');
      }
    };
    if (view === null)
      return note === null ? <Loading kind="page" label="Reading Claude Code…" /> : <p role="status">{note}</p>;
    const running = view.job?.state === 'running';
    const where = view.location.state === 'located' ? view.location.path : undefined;
    const verified = view.verification === 'verified';
    const pins = view.plan?.kind === 'self' && view.plan.pinsVersion;
    const installedVersion = view.installed?.state === 'ok' ? view.installed.version : undefined;
    const latest = knownLatest(view);
    // RISKY is decided by the TARGET, as the daemon does (a verified install can have a newer, unverified release to go to):
    // a newest version nobody could learn may be anything, so it asks the same yes as one known to be past the verified one.
    const targetUnknown = latest === undefined;
    const risky = targetUnknown || (view.available && versionOrder(latest, view.verified.version) > 0);
    // The safe update names the verified version when this install can pin one; otherwise the newest is the only choice,
    // and it is safe only when that is not past the verified version.
    const safeShown = pins
      ? installedVersion === undefined || versionOrder(installedVersion, view.verified.version) < 0
      : !risky;
    const safeBody: HarnessUpdateStartRequest = pins ? { target: view.verified.version } : {};
    return (
      <section aria-label="Claude Code" className="flex min-w-0 flex-col" data-settings="claude-code">
        <SettingGroup label="Claude Code">
          <SettingRow
            name="Runs"
            hint={<span className="break-all">{where ?? 'not found on this machine'}</span>}
            {...(where === undefined ? { control: () => <Badge tone="err">Not found</Badge> } : {})}
          />
          <SettingRow
            name="Version"
            control={() => (
              <span className="text-ui text-fg">
                {view.installed?.state === 'ok' ? view.installed.version : 'unreadable'}
              </span>
            )}
          />
          <SettingRow
            name="Installed with"
            control={() => (
              <span className="text-ui text-fg">{METHOD_WORDS[view.method?.kind ?? 'unknown'] ?? 'Unknown'}</span>
            )}
          />
          <SettingRow
            name="Verified"
            hint={
              view.verification === 'unverified'
                ? `not yet verified by Ferretry (verified: ${view.verified.version})`
                : `Ferretry verified ${view.verified.version}`
            }
            control={() => <Badge tone={verified ? 'ok' : 'warn'}>{verified ? 'Verified' : 'Not verified'}</Badge>}
          />
          <SettingRow
            name="Latest"
            hint={
              view.check.state === 'never'
                ? 'Not checked yet.'
                : `Checked ${checkedWords(view.check.checkedAt)}${view.check.state === 'failed' ? ': ' + view.check.reason : ''}`
            }
            control={() => (
              <span className="text-ui text-fg">
                {(view.check.state === 'ok'
                  ? view.check.latest.version
                  : view.check.state === 'failed'
                    ? view.check.lastKnown?.latest.version
                    : undefined) ?? 'Unknown'}
              </span>
            )}
          />
          {view.plan?.kind === 'manual' ? <SettingRow name="Update" hint={view.plan.explanation} /> : null}
          {view.job?.state === 'finished' ? <SettingRow name="Last update" hint={view.job.report.message} /> : null}
          {view.plan?.kind === 'self' && safeShown ? (
            <SettingRow
              name="Update"
              wide
              control={() => (
                <Button variant="primary" disabled={running} onClick={() => void update(safeBody)}>
                  {running ? 'Updating…' : 'Update Claude Code'}
                </Button>
              )}
            />
          ) : null}
        </SettingGroup>
        {view.plan?.kind === 'self' && risky ? (
          // RISKY, so it is a group of its own at the foot with a danger button and the consequence in words (not a neutral
          // button beside the safe update): the same install can break what Ferretry has tested.
          <SettingGroup label="Risky: an unverified version" settingId="claude-code-unverified-update">
            <SettingRow
              name="Update to the newest version"
              hint={`Ferretry has not verified ${targetUnknown ? 'the newest version' : latest}. It may change how Claude Code behaves and could break runs that work today.${safeShown ? ' The verified update above is the safe one.' : ''}`}
              wide
              control={() => (
                <Button
                  variant="danger"
                  className="h-auto min-h-[44px] w-full max-w-full whitespace-normal py-2 text-left md:w-auto"
                  disabled={running}
                  data-unverified-update=""
                  onClick={() => setConfirming(true)}
                >
                  Update to a version Ferretry has not verified
                </Button>
              )}
            />
          </SettingGroup>
        ) : null}
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Update to a version Ferretry has not verified?"
          footer={
            <>
              <Button variant="ghost" data-unverified-cancel="" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                data-unverified-confirm=""
                onClick={() => {
                  setConfirming(false);
                  void update({ confirmUnverified: true, ...(pins && latest !== undefined ? { target: latest } : {}) });
                }}
              >
                Update anyway
              </Button>
            </>
          }
        >
          <p className="m-0 text-ui text-fg">
            {targetUnknown
              ? 'Ferretry could not learn which version this would install, so it may be one it has not verified.'
              : `Claude Code ${latest} is newer than ${view.verified.version}, the newest version Ferretry verified.`}{' '}
            It may change how Claude Code behaves and could break runs that work today. Nothing is changed until you
            confirm.
          </p>
        </Dialog>
        {note === null ? null : (
          <p className="m-0 mb-8 text-meta text-err" role="alert">
            {note}
          </p>
        )}
      </section>
    );
  };
