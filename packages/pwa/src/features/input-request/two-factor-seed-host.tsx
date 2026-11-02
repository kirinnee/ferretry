/**
 * The staged 2FA seed an agenda item points at (`twoFactorSeed`), as the owner's card. It reads where the stage stands
 * and the account's name from the daemon (never from the item's text), and Allow is the same two steps as the
 * automatic-codes panel: the `add-2fa-key` passkey bound to THIS stage, then the commit. Deny drops the stage. A dismissed
 * passkey leaves the stage waiting (it expires on its own), so the owner can try again or Deny. A daemon that cannot be
 * read draws nothing, and the card still shows the daemon's words. Those name only where the account signs in (agenda
 * text is every ferret's to read): the account's name and what the key says it is for come from the reads.
 */

import {
  type AccountId,
  type AccountList,
  type AgendaItem,
  TWO_FACTOR_ERROR_CODES,
  type TwoFactorSeedStageView,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import {
  accountWords,
  addKeyActWords,
  DISMISSED_WORDS,
  savedSeedWords,
  seedFailureWords,
} from '../../lib/automatic-codes.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { commitSeed, dropSeed, type InputClient, readAccounts, readSeedStage } from '../../lib/input-api.ts';
import { useAddKeyStepUp, useDaemonClient } from '../../lib/store.tsx';
import {
  SEED_DENIED_WORDS,
  SEED_GONE_WORDS,
  type SeedCardFacts,
  type SeedCheck,
  seedCardFacts,
} from '../../lib/two-factor-seed-card.ts';
import { type SeedCardPhase, TwoFactorSeedCard } from './two-factor-seed-card.tsx';

export interface TwoFactorSeedHostProps {
  readonly connection: DaemonConnection;
  readonly item: Pick<AgendaItem, 'twoFactorSeed' | 'subject' | 'why' | 'context'>;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  /** Asks for the passkey bound to the stage, in place of the store's step-up (the harness and tests). */
  readonly addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
  readonly onDone?: () => void;
}

const FINISHED: Readonly<Record<Exclude<TwoFactorSeedStageView['state'], 'waiting'>, SeedCardPhase>> = {
  saved: { kind: 'done', ok: true, words: 'Saved. Ferretry will make this account’s codes from now on.' },
  dropped: { kind: 'done', ok: false, words: SEED_DENIED_WORDS },
  expired: { kind: 'done', ok: false, words: SEED_GONE_WORDS },
};

/** "The key says it is for GitHub · kirinnee.", from the stage read (a route that reads the accounts), or nothing. */
const keySaysLine = (stage: TwoFactorSeedStageView): string | undefined => {
  const says = [stage.issuer, stage.accountName].filter(part => part !== undefined).join(' · ');
  return says === '' ? undefined : `The key says it is for ${says}.`;
};

/** The stage's line first, unless an older daemon already put it in the card's context. */
const withKeySays = (facts: SeedCardFacts, says: string | undefined): SeedCardFacts =>
  says === undefined || facts.lines.includes(says) ? facts : { ...facts, lines: [says, ...facts.lines] };

const isStageView = (read: unknown): read is TwoFactorSeedStageView =>
  typeof read === 'object' && read !== null && 'state' in read;

const isStageGone = (failure: unknown): boolean =>
  typeof failure === 'object' &&
  failure !== null &&
  'code' in failure &&
  failure.code === TWO_FACTOR_ERROR_CODES.stageGone;

export function TwoFactorSeedHost({
  connection,
  item,
  createClient: injected,
  addKey: injectedAddKey,
  onDone,
}: TwoFactorSeedHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const requireAddKey = useAddKeyStepUp();
  const ref = item.twoFactorSeed;
  const askKey =
    injectedAddKey ??
    (requireAddKey === undefined
      ? undefined
      : (stage: TwoFactorStageId, words: string) => requireAddKey(connection, stage, words));
  const [client, setClient] = useState<InputClient | null>(null);
  const [accounts, setAccounts] = useState<AccountList | undefined>(undefined);
  const [phase, setPhase] = useState<SeedCardPhase>({ kind: 'waiting' });
  const [flagged, setFlagged] = useState(false);
  const [says, setSays] = useState<string | undefined>(undefined);
  /** The account the stage is for, as the stage read says: the card itself names none. */
  const [staged, setStaged] = useState<AccountId | undefined>(undefined);
  const [check, setCheck] = useState<SeedCheck>('checking');
  const [reads, setReads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` only re-runs the read when the owner presses Try again
  useEffect(() => {
    if (ref === undefined) return undefined;
    let current = true;
    setClient(null);
    setCheck('checking');
    void createClient(connection)
      .then(async next => {
        if (!current) return;
        setClient(next);
        const [list, stage] = await Promise.all([
          readAccounts(next).catch(() => undefined),
          readSeedStage(next, ref.account, ref.stage).catch((cause: unknown) => cause),
        ]);
        if (!current) return;
        setAccounts(list);
        if (!isStageView(stage)) {
          // A stage the daemon does not know for this caller is gone: saved, denied elsewhere, timed out, or staged
          // by someone this app cannot see. Any other failed read leaves the card as the daemon worded it.
          if (isStageGone(stage)) setPhase(FINISHED.expired);
          setCheck('failed');
          return;
        }
        setCheck('ok');
        setStaged(stage.account);
        setFlagged(stage.mismatch === true);
        setSays(keySaysLine(stage));
        if (stage.state !== 'waiting') setPhase(FINISHED[stage.state]);
      })
      .catch(() => {
        if (current) setCheck('failed');
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, ref, reads]);

  const target = ref?.account ?? staged;
  const account = accounts?.accounts.find(each => each.id === target);
  const named = account === undefined ? 'this account' : accountWords(account);

  const allow = useCallback(async (): Promise<void> => {
    if (ref === undefined || client === null || target === undefined) return;
    if (askKey === undefined) {
      setPhase({ kind: 'failed', words: 'This device cannot confirm with a passkey, so it cannot save this key.' });
      return;
    }
    setPhase({ kind: 'passkey' });
    try {
      if (!(await askKey(ref.stage, addKeyActWords(account ?? { label: named })))) {
        setPhase({ kind: 'failed', words: DISMISSED_WORDS });
        return;
      }
      setPhase({ kind: 'saving' });
      const saved = await commitSeed(client, target, ref.stage);
      setPhase({ kind: 'done', ok: true, words: savedSeedWords(saved, account?.label ?? named) });
      onDone?.();
    } catch (cause) {
      setPhase({ kind: 'failed', words: seedFailureWords(cause) });
    }
  }, [account, askKey, client, named, onDone, ref, target]);

  const deny = useCallback(async (): Promise<void> => {
    if (ref === undefined || client === null || target === undefined) return;
    try {
      await dropSeed(client, target, ref.stage);
      setPhase(FINISHED.dropped);
      onDone?.();
    } catch (cause) {
      setPhase({ kind: 'failed', words: seedFailureWords(cause) });
    }
  }, [client, onDone, ref, target]);

  if (ref === undefined || client === null) return null;
  return (
    <TwoFactorSeedCard
      check={check}
      facts={withKeySays(seedCardFacts(item.context ?? undefined, flagged), says)}
      onRetry={() => setReads(count => count + 1)}
      onAllow={() => void allow()}
      onDeny={() => void deny()}
      phase={phase}
      subject={
        account === undefined
          ? (item.subject ?? `Save automatic codes to ${named}?`)
          : `Save automatic codes to ${named}?`
      }
    />
  );
}
