/**
 * The live, daemon-bound pre-approval rules (`/v1/copy-rules`). Like the saved logins it owns no module cache: the
 * rules belong to a machine, the loaded list is stamped with the daemon it came from, and a load that failed is a
 * stated refusal rather than "no rules".
 */

import type {
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettings,
  PasteRuleSettingsView,
} from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  addRule,
  changeCopySettings,
  type CopyClient,
  listRules,
  type CopySettingsRead,
  readCopySettings,
  removeRule,
} from '../../lib/secure-copy.ts';
import { CopyRulesCard } from './copy-rules-card.tsx';

export type CopyClientFactory = (connection: DaemonConnection) => Promise<CopyClient>;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly rules: readonly PasteRule[];
  /** Absent from a daemon too old to have the setting: no switch and no badge are shown. */
  readonly settings?: PasteRuleSettingsView;
  /** Why the setting and the badges could not be read, when that was not "an older daemon". */
  readonly settingsError?: string;
}

/** What the screen holds from one read of the rules and one of the settings. */
const loadedFrom = (
  daemonId: DaemonConnection['daemonId'],
  list: PasteRuleList,
  settings: CopySettingsRead,
): Loaded => ({
  daemonId,
  rules: list.rules,
  ...(settings.kind === 'view' ? { settings: settings.view } : {}),
  ...(settings.kind === 'failed' ? { settingsError: settings.reason } : {}),
});

/** Both reads, side by side. */
const readAll = async (client: CopyClient) => await Promise.all([listRules(client), readCopySettings(client)] as const);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function CopyRulesSurface({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: CopyClientFactory;
}) {
  const [client, setClient] = useState<CopyClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setError(null);
    setFailure(null);
    void createClient(connection)
      .then(async next => {
        const [list, settings] = await readAll(next);
        if (!current) return;
        setClient(next);
        setLoaded(loadedFrom(connection.daemonId, list, settings));
      })
      .catch(cause => {
        if (current) setFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  /** Runs one change, re-reads so the screen is what the daemon holds, and says whether it took. */
  const write = useCallback(
    async (action: (next: CopyClient) => Promise<unknown>): Promise<boolean> => {
      if (client === null) return false;
      setBusy(true);
      setError(null);
      try {
        await action(client);
        setLoaded(loadedFrom(connection.daemonId, ...(await readAll(client))));
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId],
  );

  const add = useCallback((rule: PasteRuleCreate) => write(next => addRule(next, rule)), [write]);
  const remove = useCallback((id: string) => write(next => removeRule(next, id)), [write]);
  const changeSettings = useCallback(
    (settings: PasteRuleSettings) => write(next => changeCopySettings(next, settings)),
    [write],
  );

  if (failure !== null && failure.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Approved pastes unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Approved pastes unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s paste rules: {failure.reason}. Until it can, every paste asks you.
        </p>
      </section>
    );

  if (loaded === null || loaded.daemonId !== connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading approved pastes">
        <p className="m-0 text-ui text-faint">Reading this daemon’s paste rules…</p>
      </section>
    );

  return (
    <CopyRulesCard
      rules={loaded.rules}
      {...(loaded.settings === undefined
        ? {}
        : { settings: loaded.settings.settings, profileRules: loaded.settings.profileRules })}
      {...(loaded.settingsError === undefined ? {} : { settingsError: loaded.settingsError })}
      busy={busy}
      error={error}
      onAdd={add}
      onRemove={remove}
      onSettings={changeSettings}
    />
  );
}
