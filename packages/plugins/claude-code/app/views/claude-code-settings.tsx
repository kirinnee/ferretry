/**
 * Settings › Claude Code: where claude is, how it was installed, its version, whether Ferretry verified it, and the
 * update. The same daemon view `fy harness claude-code status` prints, so a terminal and a phone cannot disagree.
 */

import { Badge, Button, SettingGroup, SettingRow } from '@ferretry/app';
import { Loading } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import type { HarnessCliView } from '../../contract/index.ts';

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
  const when = new Date(instant);
  return Number.isNaN(when.getTime()) ? instant : when.toLocaleString();
};

export const createSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function ClaudeCodeSettings() {
    const [view, setView] = useState<HarnessCliView | null>(null);
    const [note, setNote] = useState<string | null>(null);
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
    const update = async (confirmUnverified: boolean): Promise<void> => {
      setNote(null);
      try {
        setView(
          await client.call<HarnessCliView>('POST /v1/claude-code/update', {
            body: confirmUnverified ? { confirmUnverified: true } : {},
          }),
        );
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : 'The update could not be started.');
      }
    };
    if (view === null)
      return note === null ? <Loading kind="page" label="Reading Claude Code…" /> : <p role="status">{note}</p>;
    const running = view.job?.state === 'running';
    const where = view.location.state === 'located' ? view.location.path : undefined;
    const verified = view.verification === 'verified';
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
          {view.plan?.kind === 'self' ? (
            <SettingRow
              name="Update"
              wide
              control={() => (
                <Button variant="primary" disabled={running} onClick={() => void update(false)}>
                  {running ? 'Updating…' : 'Update Claude Code'}
                </Button>
              )}
            />
          ) : null}
          {view.plan?.kind === 'self' && view.verification === 'unverified' ? (
            <SettingRow name="Unverified version" hint="Ferretry has not verified the newest version.">
              <div className="pb-3">
                <Button
                  className="h-auto min-h-[44px] max-w-full whitespace-normal py-2 text-left"
                  disabled={running}
                  onClick={() => void update(true)}
                >
                  Update to a version Ferretry has not verified
                </Button>
              </div>
            </SettingRow>
          ) : null}
        </SettingGroup>
        {note === null ? null : (
          <p className="m-0 mb-8 text-meta text-err" role="alert">
            {note}
          </p>
        )}
      </section>
    );
  };
