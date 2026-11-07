/**
 * The live, daemon-bound pre-approval rules (`/v1/copy-rules`). Like the saved logins it owns no module cache: the
 * rules belong to a machine, the loaded list is stamped with the daemon it came from, and a load that failed is a
 * stated refusal rather than "no rules".
 *
 * Making a rule is staged (owner decision !A244), approved with a passkey bound to that one rule whose prompt lists the
 * daemon's rows, and only then committed; the rules a machine staged (`fy copy rules add`) wait here for the same
 * passkey. Removing a rule, or turning profile programs off, only takes away and needs none.
 */

import type {
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettings,
  PasteRuleSettingsView,
  PasteRuleStaged,
} from '../../../contract/routes/index.ts';
import { useCallback, useEffect, useState } from 'react';
import {
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

interface Loaded {
  readonly rules: readonly PasteRule[];
  /** Absent while the setting could not be read: no switch and no badge are shown (see `settingsError`). */
  readonly settings?: PasteRuleSettingsView;
  /** Why the setting and the badges could not be read. */
  readonly settingsError?: string;
  /** The paste rules waiting for their passkey. */
  readonly waiting: readonly PasteRuleStaged[];
}

/** What the screen holds from one read of the rules and one of the settings. */
const loadedFrom = (list: PasteRuleList, settings: CopySettingsRead, waiting: readonly PasteRuleStaged[]): Loaded => ({
  rules: list.rules,
  waiting,
  ...(settings.kind === 'view' ? { settings: settings.view } : {}),
  ...(settings.kind === 'failed' ? { settingsError: settings.reason } : {}),
});

/** Every read, side by side. Waiting stages that cannot be read show none: the add still stages and asks. */
const readAll = async (client: CopyClient) =>
  await Promise.all([
    listRules(client),
    readCopySettings(client),
    listPasteRuleStages(client).catch((): readonly PasteRuleStaged[] => []),
  ] as const);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function CopyRulesSurface({
  client,
  askPasskey,
}: {
  /** The Accounts client of the machine this tab is on. */
  readonly client: CopyClient;
  /** Asks for the `approve-paste-rule` passkey bound to a stage; absent where this device cannot ask. */
  readonly askPasskey?: PasteRuleAsk;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError(null);
    setFailure(null);
    void readAll(client)
      .then(([list, settings, waiting]) => {
        if (current) setLoaded(loadedFrom(list, settings, waiting));
      })
      .catch(cause => {
        if (current) setFailure(message(cause));
      });
    return () => {
      current = false;
    };
  }, [client]);

  /** Runs one change, re-reads so the screen is what the daemon holds, and says whether it took. */
  const write = useCallback(
    async (action: (next: CopyClient) => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const done = await action(client);
        setLoaded(loadedFrom(...(await readAll(client))));
        return done !== false;
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client],
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
    (rule: PasteRuleCreate) => write(async next => await approve(next, await stagePasteRule(next, rule))),
    [write, approve],
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
        settings.allowProfileTargets
          ? await approve(next, await stageProfileTargets(next))
          : await changeCopySettings(next, settings),
      ),
    [write, approve],
  );

  if (failure !== null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Approved pastes unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Approved pastes unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read this daemon’s paste rules: {failure}. Until it can, every paste asks you.
        </p>
      </section>
    );

  if (loaded === null)
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
