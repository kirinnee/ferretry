/**
 * The live, daemon-bound pre-approval rules (`/v1/copy-rules`). Like the saved logins it owns no module cache: the
 * rules belong to a machine, the loaded list is stamped with the daemon it came from, and a load that failed is a
 * stated refusal rather than "no rules".
 *
 * On a machine that stages paste rules (`copy-rules.passkey.1`, owner decision !A244), making one is staged, approved
 * with a passkey bound to that one rule whose prompt lists the daemon's rows, and only then committed; the rules a
 * machine staged (`fy copy rules add`) wait here for the same passkey. An older machine keeps the one-step add.
 */

import type {
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettings,
  PasteRuleSettingsView,
  PasteRuleStaged,
} from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  addRule,
  changeCopySettings,
  type CopyClient,
  confirmPasteRuleStage,
  dropPasteRuleStage,
  listPasteRuleStages,
  listRules,
  type CopySettingsRead,
  type PasteRuleAsk,
  readCopySettings,
  removeRule,
  stagePasteRule,
  stageProfileTargets,
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
  /** The paste rules waiting for their passkey; empty on a machine that does not stage them. */
  readonly waiting: readonly PasteRuleStaged[];
}

/** What the screen holds from one read of the rules and one of the settings. */
const loadedFrom = (
  daemonId: DaemonConnection['daemonId'],
  list: PasteRuleList,
  settings: CopySettingsRead,
  waiting: readonly PasteRuleStaged[],
): Loaded => ({
  daemonId,
  rules: list.rules,
  waiting,
  ...(settings.kind === 'view' ? { settings: settings.view } : {}),
  ...(settings.kind === 'failed' ? { settingsError: settings.reason } : {}),
});

/** Every read, side by side. Waiting stages that cannot be read show none: the add still stages and asks. */
const readAll = async (client: CopyClient, staging: boolean) =>
  await Promise.all([
    listRules(client),
    readCopySettings(client),
    staging ? listPasteRuleStages(client).catch((): readonly PasteRuleStaged[] => []) : [],
  ] as const);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function CopyRulesSurface({
  connection,
  createClient,
  staging = false,
  askPasskey,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: CopyClientFactory;
  /** The machine makes a paste rule only with a passkey bound to it (`copy-rules.passkey.1`). */
  readonly staging?: boolean;
  /** Asks for the `approve-paste-rule` passkey bound to a stage; absent where this device cannot ask. */
  readonly askPasskey?: PasteRuleAsk;
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
        const [list, settings, waiting] = await readAll(next, staging);
        if (!current) return;
        setClient(next);
        setLoaded(loadedFrom(connection.daemonId, list, settings, waiting));
      })
      .catch(cause => {
        if (current) setFailure({ daemonId: connection.daemonId, reason: message(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, staging]);

  /** Runs one change, re-reads so the screen is what the daemon holds, and says whether it took. */
  const write = useCallback(
    async (action: (next: CopyClient) => Promise<unknown>): Promise<boolean> => {
      if (client === null) return false;
      setBusy(true);
      setError(null);
      try {
        const done = await action(client);
        setLoaded(loadedFrom(connection.daemonId, ...(await readAll(client, staging))));
        return done !== false;
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, staging],
  );

  /** One staged change through its passkey: made, or nothing approved (a dismissed prompt is not an error). */
  const approve = useCallback(
    async (next: CopyClient, staged: PasteRuleStaged, taken = false): Promise<boolean> => {
      const outcome = await confirmPasteRuleStage(next, askPasskey, staged, { taken });
      if (outcome.kind === 'failed') throw new Error(outcome.words);
      return outcome.kind === 'made';
    },
    [askPasskey],
  );
  const add = useCallback(
    (rule: PasteRuleCreate) =>
      write(async next =>
        staging ? await approve(next, await stagePasteRule(next, rule)) : await addRule(next, rule),
      ),
    [write, staging, approve],
  );
  const approveWaiting = useCallback(
    (staged: PasteRuleStaged) => write(next => approve(next, staged, true)),
    [write, approve],
  );
  const denyWaiting = useCallback(
    (staged: PasteRuleStaged) => write(next => dropPasteRuleStage(next, staged.stage)),
    [write],
  );
  const remove = useCallback((id: string) => write(next => removeRule(next, id)), [write]);
  // Turning profile targets ON widens every terminal rule it could match: staged with its own passkey on a machine that
  // stages paste changes (secrev-1334 M2). Turning it off is the one-step write.
  const changeSettings = useCallback(
    (settings: PasteRuleSettings) =>
      write(async next =>
        staging && settings.allowProfileTargets
          ? await approve(next, await stageProfileTargets(next))
          : await changeCopySettings(next, settings),
      ),
    [write, staging, approve],
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
      waiting={loaded.waiting}
      onApproveWaiting={approveWaiting}
      onDenyWaiting={denyWaiting}
      onAdd={add}
      onRemove={remove}
      onSettings={changeSettings}
    />
  );
}
