/**
 * Settings › Secure copy › Standing sign-in rules: every rule on this machine with its status (an owner-side word: a
 * suspension is never put in a ferret's session), the rules a machine staged with `fy rules add` waiting for this
 * device's passkey, and one tap to narrow or revoke. Narrowing and revoking need no passkey, because they only take
 * away; resuming or approving again opens the sheet. Names come from the secrets-gated rule route; a device that may not
 * use secrets sees one sentence and the page stops asking.
 */

import type { SignInRuleList, SignInRuleStaged, SignInRuleView } from '@ferretry/protocol';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  dropRuleStage,
  failureWords,
  isForbidden,
  listRules,
  narrowRule,
  RULE_DAMAGED_WORDS,
  RULE_NO_ACCOUNTS_DEVICE_WORDS,
  type RuleClient,
  type RuleProgress,
  revokeRule,
  runMachineRuleConfirm,
  stagedFlags,
  timeWords,
} from '../../lib/sign-in-rules.ts';
import { useApproveSignInRuleStepUp } from '../../lib/store.tsx';
import { SignInRuleCard } from '../accounts/sign-in-rule-card.tsx';
import { SignInRuleSheetHost } from '../accounts/sign-in-rule-panel.tsx';
import { RuleHonestLine, RuleRootBlock, RuleStillAsked } from '../accounts/sign-in-rule-sheet.tsx';

const POLL_MS = 5_000;

type Ask = ((stage: `srs_${string}`, words: string) => Promise<boolean>) | undefined;

export interface SignInRulesSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient: (connection: DaemonConnection) => Promise<RuleClient>;
  /** Asks for the passkey bound to the stage, in place of the store's step-up (the harness and tests). */
  readonly askPasskey?: Ask;
  /** How often the list is read again (the harness and tests). */
  readonly pollMs?: number;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed'; readonly words: string }
  | { readonly kind: 'ready'; readonly list: SignInRuleList };

const PROGRESS_WORDS: Readonly<Record<RuleProgress, string>> = {
  staging: 'Taking it…',
  passkey: 'Waiting for your passkey…',
  committing: 'Approving…',
};

/** A rule a machine staged, waiting for this device's passkey. Every warning is drawn from the stage's structured flags. */
export function MachineRuleStage({
  staged,
  phase,
  canUsePasskey,
  onConfirm,
  onDeny,
}: {
  readonly staged: SignInRuleList['stages'][number];
  readonly phase:
    | { readonly kind: 'idle' }
    | { readonly kind: 'working'; readonly progress: RuleProgress }
    | { readonly kind: 'dismissed' }
    | { readonly kind: 'failed'; readonly words: string };
  readonly canUsePasskey: boolean;
  readonly onConfirm: () => void;
  readonly onDeny: () => void;
}) {
  const flags = stagedFlags(staged);
  const working = phase.kind === 'working';
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-rule-stage={staged.stage}
    >
      <p className="m-0 text-ui font-medium text-fg" data-rule-machine="">
        A machine asked for this rule
        {staged.machine === undefined ? '' : ` at ${timeWords(staged.machine.askedAt)}`}
      </p>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ui text-fg" data-rule-machine-summary="">
        {staged.summary.map(line => (
          <li className="break-words" key={line}>
            {line}
          </li>
        ))}
      </ul>
      {staged.root ? <RuleRootBlock place={staged.place} /> : null}
      {flags
        .filter(flag => flag.name !== 'root')
        .map(flag => (
          <span
            className={`flex items-start gap-1.5 text-meta font-medium ${flag.tone === 'err' ? 'text-err' : 'text-warn'}`}
            data-rule-flag={flag.name}
            key={flag.name}
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
            <span className="min-w-0 break-words">{flag.words}</span>
          </span>
        ))}
      <p className="m-0 text-meta text-muted">
        Waits until <span className="mono">{timeWords(staged.stageExpiresAt)}</span>. The rule ends{' '}
        <span className="mono">{timeWords(staged.expiresAt)}</span>.
      </p>
      {phase.kind === 'working' ? (
        <p className="m-0 text-ui text-muted" data-rule-progress={phase.progress} role="status">
          {PROGRESS_WORDS[phase.progress]}
        </p>
      ) : null}
      {phase.kind === 'dismissed' ? (
        <p className="m-0 text-ui text-warn" data-rule-dismissed="" role="status">
          The passkey was dismissed, so nothing was approved.
        </p>
      ) : null}
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-rule-failure="" role="alert">
          {phase.words}
        </p>
      ) : null}
      {canUsePasskey ? null : (
        <p className="m-0 text-meta text-warn" data-rule-no-passkey="">
          This device cannot confirm with a passkey. Deny, or open this on a device that can.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2" data-rule-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-rule-machine-deny=""
          disabled={working}
          onClick={onDeny}
          type="button"
        >
          Deny
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-rule-machine-confirm=""
          data-variant="primary"
          disabled={working || !canUsePasskey}
          onClick={onConfirm}
          type="button"
        >
          {working ? 'Approving…' : 'Confirm with passkey'}
        </button>
      </div>
    </article>
  );
}

type StagePhase = Parameters<typeof MachineRuleStage>[0]['phase'];

export function SignInRulesSurface({
  connection,
  createClient,
  askPasskey: injected,
  pollMs = POLL_MS,
}: SignInRulesSurfaceProps) {
  const askStage = useApproveSignInRuleStepUp();
  const ask = useMemo<Ask>(
    () => injected ?? (askStage === undefined ? undefined : (stage, words) => askStage(connection, stage, words)),
    [askStage, connection, injected],
  );
  const [client, setClient] = useState<RuleClient | null>(null);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [stagePhases, setStagePhases] = useState<Readonly<Record<string, StagePhase>>>({});
  const [again, setAgain] = useState<
    { readonly rule: SignInRuleView; readonly origin: 'resume' | 'renew' } | undefined
  >(undefined);
  const [reads, setReads] = useState(0);
  const forbidden = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read after a change
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    forbidden.current = false;
    const readOnce = async (next: RuleClient): Promise<void> => {
      try {
        const list = await listRules(next);
        if (!current) return;
        setRead({ kind: 'ready', list });
        timer = setTimeout(() => void readOnce(next), pollMs);
      } catch (cause) {
        if (!current) return;
        // A device that may not use secrets is refused every time: say so once and stop asking.
        if (isForbidden(cause)) {
          forbidden.current = true;
          setRead({ kind: 'forbidden' });
        } else {
          setRead({ kind: 'failed', words: failureWords(cause) });
          timer = setTimeout(() => void readOnce(next), pollMs * 3);
        }
      }
    };
    void createClient(connection)
      .then(next => {
        if (!current) return undefined;
        setClient(next);
        return readOnce(next);
      })
      .catch(cause => {
        if (current) setRead({ kind: 'failed', words: failureWords(cause) });
      });
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [connection, createClient, pollMs, reads]);

  const reload = useCallback(() => setReads(count => count + 1), []);

  const act = useCallback(
    async (key: string, action: (next: RuleClient) => Promise<unknown>): Promise<void> => {
      if (client === null) return;
      setBusy(true);
      setFailures(held => ({ ...held, [key]: '' }));
      try {
        await action(client);
        reload();
      } catch (cause) {
        setFailures(held => ({ ...held, [key]: failureWords(cause) }));
      } finally {
        setBusy(false);
      }
    },
    [client, reload],
  );

  const confirmStage = (staged: SignInRuleStaged | SignInRuleList['stages'][number]): void => {
    if (client === null) return;
    void runMachineRuleConfirm(
      {
        client,
        askPasskey: ask,
        report: progress => setStagePhases(held => ({ ...held, [staged.stage]: { kind: 'working', progress } })),
      },
      staged.stage,
    ).then(outcome => {
      const phase: StagePhase =
        outcome.kind === 'settled'
          ? { kind: 'idle' }
          : outcome.kind === 'dismissed'
            ? { kind: 'dismissed' }
            : { kind: 'failed', words: outcome.words };
      setStagePhases(held => ({ ...held, [staged.stage]: phase }));
      reload();
    });
  };

  if (read.kind === 'loading')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading standing sign-in rules">
        <p className="m-0 text-ui text-faint">Reading this daemon’s standing sign-in rules…</p>
      </section>
    );

  return (
    <section className="kt-panel p-panel" aria-label="Standing sign-in rules" data-sign-in-rules="">
      <h3 className="m-0 text-row font-semibold text-fg">Standing sign-in rules</h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        Sign-ins you approved once, for any ferret, with a passkey. They end on time, on their cap, or the moment you
        revoke them.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <RuleHonestLine />
      </div>
      {read.kind === 'forbidden' ? (
        <p className="mb-0 mt-3 text-ui text-warn" data-sign-in-rules-forbidden="" role="status">
          {RULE_NO_ACCOUNTS_DEVICE_WORDS}
        </p>
      ) : null}
      {read.kind === 'failed' ? (
        <p className="mb-0 mt-3 text-ui text-err" data-sign-in-rules-error="" role="alert">
          This browser could not read this daemon’s standing rules: {read.words}
        </p>
      ) : null}
      {read.kind === 'ready' ? (
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          {read.list.health === 'damaged' ? (
            <p className="m-0 text-ui text-err" data-rule-damaged="" role="alert">
              {RULE_DAMAGED_WORDS}
            </p>
          ) : null}
          {again === undefined || client === null ? null : (
            <SignInRuleSheetHost
              accountName={again.rule.account.label}
              autoRecipe={again.rule.flags.includes('auto-recipe')}
              before={again.rule}
              codeAvailable={again.rule.totp}
              onCancel={() => setAgain(undefined)}
              onSettled={() => {
                setAgain(undefined);
                reload();
              }}
              origin={again.origin}
              place={again.rule.place}
              replaces={again.rule.id}
              rules={{ client, askPasskey: ask }}
              signIn={again.rule.signIn}
              {...(again.rule.username === undefined ? {} : { username: again.rule.username })}
            />
          )}
          {read.list.stages.map(staged => (
            <MachineRuleStage
              canUsePasskey={ask !== undefined}
              key={staged.stage}
              onConfirm={() => confirmStage(staged)}
              onDeny={() => {
                setStagePhases(held => ({ ...held, [staged.stage]: { kind: 'working', progress: 'staging' } }));
                void act(staged.stage, next => dropRuleStage(next, staged.stage)).then(() =>
                  setStagePhases(held => ({ ...held, [staged.stage]: { kind: 'idle' } })),
                );
              }}
              phase={stagePhases[staged.stage] ?? { kind: 'idle' }}
              staged={staged}
            />
          ))}
          {read.list.rules.length === 0 && read.list.stages.length === 0 ? (
            <p className="m-0 text-ui text-faint" data-sign-in-rules-empty="">
              No standing rules. Every sign-in asks you.
            </p>
          ) : (
            read.list.rules.map(rule => (
              <SignInRuleCard
                busy={busy}
                canUsePasskey={ask !== undefined}
                failure={failures[rule.id] === '' ? undefined : failures[rule.id]}
                key={rule.id}
                onNarrow={narrow => void act(rule.id, next => narrowRule(next, rule.id, narrow))}
                onReapprove={origin => setAgain({ rule, origin })}
                onRevoke={() => void act(rule.id, next => revokeRule(next, rule.id))}
                rule={rule}
              />
            ))
          )}
          <RuleStillAsked />
        </div>
      ) : null}
    </section>
  );
}
