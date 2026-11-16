/**
 * Settings › Claude Code: where claude is, how it was installed, its version, whether Ferretry verified it, and the
 * update. The same daemon view `fy harness claude-code status` prints, so a terminal and a phone cannot disagree.
 */

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
    return (
      <section aria-label="Claude Code" data-settings="claude-code">
        <dl>
          <dt>Runs</dt>
          <dd>{view.location.state === 'located' ? view.location.path : 'not found on this machine'}</dd>
          <dt>Version</dt>
          <dd>{view.installed?.state === 'ok' ? view.installed.version : 'unreadable'}</dd>
          <dt>Installed with</dt>
          <dd>{view.method?.kind ?? 'unknown'}</dd>
          <dt>Verified</dt>
          <dd>
            {view.verification === 'unverified'
              ? `not yet verified by Ferretry (verified: ${view.verified.version})`
              : `Ferretry verified ${view.verified.version}`}
          </dd>
          {view.plan?.kind === 'manual' ? (
            <>
              <dt>Update</dt>
              <dd>{view.plan.explanation}</dd>
            </>
          ) : null}
          {view.job?.state === 'finished' ? (
            <>
              <dt>Last update</dt>
              <dd>{view.job.report.message}</dd>
            </>
          ) : null}
        </dl>
        {view.plan?.kind === 'self' ? (
          <button disabled={running} onClick={() => void update(false)} type="button">
            {running ? 'Updating…' : 'Update Claude Code'}
          </button>
        ) : null}
        {view.verification === 'unverified' && view.plan?.kind === 'self' ? (
          <button disabled={running} onClick={() => void update(true)} type="button">
            Update to a version Ferretry has not verified
          </button>
        ) : null}
        {note === null ? null : <p role="alert">{note}</p>}
      </section>
    );
  };
