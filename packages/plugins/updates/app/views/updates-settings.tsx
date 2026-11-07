/**
 * Settings › Updates: how this daemon was installed, whether it is behind, and the update. The same view `fy update`
 * prints, so a terminal and a phone cannot disagree. Turning on automatic installs is a loosening the owner confirms:
 * the daemon answers `202` with the sentence and the switch stays off until then.
 */

import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import {
  type DaemonUpdateSettingsHeld,
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
  describeInstallMethod,
} from '../../contract/index.ts';
import { behindSentence, refusalSentence, updateOffer, updateRequest } from '../lib/behind.ts';

export const createSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function UpdatesSettings() {
    const [view, setView] = useState<DaemonUpdateView | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const read = useCallback(async () => {
      try {
        setView(DaemonUpdateViewSchema.parse(await client.call('GET /v1/daemon/update')));
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : 'The update state could not be read.');
      }
    }, []);
    useEffect(() => {
      void read();
    }, [read]);

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

    if (view === null) return <p>{note ?? 'Reading the update state…'}</p>;
    const offer = updateOffer(view);
    return (
      <section aria-label="Updates">
        <p>
          Running {view.current}, installed via {describeInstallMethod(view.method)}.
        </p>
        <p>{behindSentence(view) ?? 'This daemon is up to date.'}</p>
        {offer.kind === 'busy' ? <p>{offer.sentence}</p> : null}
        {offer.kind === 'update' ? (
          <p>
            <button type="button" onClick={() => void start(offer.target, 'now')}>
              Update to {offer.target}
            </button>{' '}
            <button type="button" onClick={() => void start(offer.target, 'when-idle')}>
              Update when no ferret is mid-turn
            </button>
            {offer.midTurn > 0 ? <span> {offer.midTurn} mid-turn now; they keep running through the restart.</span> : null}
          </p>
        ) : null}
        {offer.kind === 'steps' ? (
          <div>
            <p>{offer.explanation}</p>
            <ol>
              {offer.steps.map(step => (
                <li key={step.command}>
                  <code>{step.command}</code>
                  {step.note === undefined ? null : <span> — {step.note}</span>}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={view.autoInstall}
            onChange={event => void setAutoInstall(event.currentTarget.checked)}
          />{' '}
          Install updates automatically when no ferret is mid-turn
        </label>
        {view.job?.state === 'finished' ? <p>{view.job.report.message}</p> : null}
        {note === null ? null : <p role="status">{note}</p>}
      </section>
    );
  };
