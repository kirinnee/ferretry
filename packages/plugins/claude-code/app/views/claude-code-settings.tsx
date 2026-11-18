/**
 * Settings › Claude Code: where claude is, how it was installed, its version, whether Ferretry verified it, and the
 * update. The same daemon view `fy harness claude-code status` prints, so a terminal and a phone cannot disagree.
 */

import { Badge, Button, SettingGroup, SettingRow } from '@ferretry/app';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import type { HarnessCliView } from '../../contract/index.ts';

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
    if (view === null) return <p role="status">{note ?? 'Reading Claude Code…'}</p>;
    const running = view.job?.state === 'running';
    const where = view.location.state === 'located' ? view.location.path : undefined;
    const verified = view.verification === 'verified';
    return (
      <section aria-label="Claude Code" className="flex flex-col gap-4" data-settings="claude-code">
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
            control={() => <span className="text-ui text-fg">{view.method?.kind ?? 'unknown'}</span>}
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
          {view.plan?.kind === 'manual' ? <SettingRow name="Update" hint={view.plan.explanation} /> : null}
          {view.job?.state === 'finished' ? <SettingRow name="Last update" hint={view.job.report.message} /> : null}
        </SettingGroup>
        {view.plan?.kind === 'self' ? (
          <div className="flex flex-wrap gap-2 max-md:[&>button]:w-full">
            <Button variant="primary" disabled={running} onClick={() => void update(false)}>
              {running ? 'Updating…' : 'Update Claude Code'}
            </Button>
            {view.verification === 'unverified' ? (
              <Button disabled={running} onClick={() => void update(true)}>
                Update to a version Ferretry has not verified
              </Button>
            ) : null}
          </div>
        ) : null}
        {note === null ? null : (
          <p className="m-0 text-meta text-err" role="alert">
            {note}
          </p>
        )}
      </section>
    );
  };
