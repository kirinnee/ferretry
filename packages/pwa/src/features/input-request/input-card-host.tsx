/**
 * The input card, fetched: finds the request an `input` agenda item points at and keeps it fresh.
 *
 * The request is read from the daemon by the item's `input.requestId`, never from the item (the item holds no
 * facts: they live in the daemon's RAM and are re-observed after a restart). While the daemon is still
 * re-observing the target (`observed` absent) the host asks again every few seconds so Send comes back by itself.
 * The last request read is kept: once it is sent the daemon stops listing it, and the card must still say what
 * happened rather than vanish.
 */

import {
  type AccountList,
  type AgendaItem,
  DAEMON_FEATURES,
  type InputRequest,
  strongestSensitivity,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineOffers } from '../../lib/daemon-health.ts';
import type { InputClient } from '../../lib/input-api.ts';
import { readAccounts, readInputRequest } from '../../lib/input-api.ts';
import { fieldsOf } from '../../lib/input-card.ts';
import type { StepUpWords } from '../../lib/step-up-gate.ts';
import { useAddKeyStepUp, useApproveSignInRuleStepUp, useDaemonClient } from '../../lib/store.tsx';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { InputCard } from './input-card.tsx';

const INPUT_REFRESH_MS = 3_000;

export interface InputCardHostProps {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly item: Pick<AgendaItem, 'input'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  readonly onDone?: () => void;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly request: InputRequest }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'failed'; readonly text: string };

export function InputCardHost({
  connection,
  sessionId,
  item,
  agentName,
  createClient: injected,
  onDone,
}: InputCardHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const requestId = item.input?.requestId;
  const [client, setClient] = useState<InputClient | null>(null);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const settled = useRef(false);
  const health = useDaemonHealth(connection);
  const offersKeys = machineOffers(health, DAEMON_FEATURES.twoFactorKeys);
  const requireAddKey = useAddKeyStepUp();
  const askRuleStage = useApproveSignInRuleStepUp();
  const offersRules = machineOffers(health, DAEMON_FEATURES.signInRules);
  const [accounts, setAccounts] = useState<AccountList | undefined>(undefined);
  const [accountsTick, setAccountsTick] = useState(0);

  useEffect(() => {
    let current = true;
    setClient(null);
    void createClient(connection)
      .then(next => {
        if (current) setClient(next);
      })
      .catch(cause => {
        if (current) setRead({ kind: 'failed', text: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null || requestId === undefined || settled.current) return;
    try {
      const request = await readInputRequest(client, sessionId, requestId);
      setRead(previous =>
        request === 'unreadable'
          ? { kind: 'unreadable' }
          : request !== undefined
            ? { kind: 'open', request }
            : previous.kind === 'open'
              ? previous
              : { kind: 'gone' },
      );
    } catch (cause) {
      setRead(previous =>
        previous.kind === 'open'
          ? previous
          : { kind: 'failed', text: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }, [client, requestId, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), INPUT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // A code card reads them for its keys; any other card with saved accounts, to name whose sign-in it is in its title.
  // The listing is secrets-gated (`GET /v1/accounts` needs `secrets.use`): a device refused it keeps the place-only title.
  const wantsAccounts =
    read.kind === 'open' &&
    read.request.saved !== undefined &&
    (strongestSensitivity(read.request.fields) === 'code' ? offersKeys : true);
  useEffect(() => {
    if (!wantsAccounts || client === null) {
      setAccounts(undefined);
      return;
    }
    let current = true;
    void accountsTick;
    readAccounts(client)
      .then(list => {
        if (current) setAccounts(list);
      })
      .catch(() => {
        if (current) setAccounts(undefined);
      });
    return () => {
      current = false;
    };
  }, [wantsAccounts, client, accountsTick]);

  if (requestId === undefined) return null;
  if (read.kind === 'failed')
    return (
      <p className="m-0 text-ui text-err" role="alert">
        Could not read this request: {read.text}
      </p>
    );
  if (read.kind === 'unreadable')
    return (
      <p className="m-0 text-ui text-warn" data-input-unreadable="" role="status">
        This request needs a newer version of the app. Reload the app to answer it.
      </p>
    );
  if (read.kind === 'gone')
    return (
      <p className="m-0 text-ui text-muted" data-input-gone="" role="status">
        This request is no longer open.
      </p>
    );
  if (read.kind === 'loading' || client === null)
    return (
      <p className="m-0 text-ui text-faint" role="status">
        Reading the request…
      </p>
    );
  return (
    <InputCard
      client={client}
      embedded
      fields={fieldsOf(read.request)}
      onDone={() => {
        settled.current = true;
        onDone?.();
      }}
      onRefresh={() => {
        void refresh();
        setAccountsTick(tick => tick + 1);
      }}
      request={read.request}
      {...(accounts === undefined ? {} : { accounts })}
      {...(accounts === undefined || requireAddKey === undefined
        ? {}
        : { addKey: (stage: TwoFactorStageId, words: string) => requireAddKey(connection, stage, words) })}
      {...(agentName === undefined ? {} : { agentName })}
      {...(!offersRules
        ? {}
        : {
            ruleOffer: {
              askPasskey:
                askRuleStage === undefined
                  ? undefined
                  : (stage: `srs_${string}`, words: StepUpWords) => askRuleStage(connection, stage, words),
            },
          })}
    />
  );
}
