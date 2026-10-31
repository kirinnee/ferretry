/**
 * /join: a share link, step by step.
 *
 * Nothing is sent until the person taps Join. After `joined` the passkey must be added inside the
 * window, shown as a live countdown. A browser that already has a key for the publisher spends the link
 * with that key instead. A key the publisher refused is never deleted here: the person decides.
 */

import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { revealHidden, type ShareLinkSeed } from '@ferretry/protocol';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { Button } from '../../shell/primitives.tsx';
import { FailureLine } from '../catalogs/catalog-parts.tsx';
import { AccessRefused, JoinAgain } from './access-refused.tsx';
import type { SharedController } from './shared-controller.ts';
import {
  PASSKEY_BUTTON,
  PASSKEY_EXPLAIN,
  type Problem,
  passkeyHeading,
  passkeyWindow,
  UNLOCK_BUTTON,
  WINDOW_CLOSED_SENTENCE,
} from './shared-model.ts';
import {
  ADD_FROM_LINK,
  ADDING,
  BACK_TO_START,
  INVALID_TITLE,
  JOIN_BUTTON,
  JOIN_NOTHING_SENT,
  JOIN_TITLE,
  JOINING,
  joinFacts,
  OLD_KEY_NOTE,
  OPEN_SHARED,
  PASSKEY_ADDED,
  redeemView,
  TRY_AGAIN,
  UNLOCKED_THEN_LINK,
  UNLOCK_THEN_LINK,
  WORKING,
  windowAnnouncement,
} from './shared-screens-model.ts';
import { Fingerprint, SharedPage } from './shared-parts.tsx';
import { secondTicker, type Ticker, useClock } from './use-clock.ts';

type JoinPort = Pick<SharedController, 'begin' | 'join' | 'addPasskey' | 'unlock' | 'redeem' | 'forget' | 'tryAgain'>;

interface JoinScreenProps {
  readonly members: JoinPort;
  /** The address fragment of the link, read once. */
  readonly fragment: string;
  readonly now: () => Date;
  readonly ticker?: Ticker;
  /** Open Shared with me, on this publisher. */
  readonly onShared: (daemonId: string) => void;
  readonly onHome: () => void;
}

type JoinFailure = 'refused' | 'unreachable' | 'unsupported';

type Phase =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly seed: ShareLinkSeed; readonly oldKey: boolean }
  | { readonly kind: 'joining'; readonly seed: ShareLinkSeed; readonly oldKey: boolean }
  | {
      readonly kind: 'join-failed';
      readonly seed: ShareLinkSeed;
      readonly oldKey: boolean;
      readonly why: JoinFailure;
      readonly sentence: string;
    }
  | {
      readonly kind: 'passkey';
      readonly sub: MemberSubscription;
      readonly stage: 'add' | 'unlock';
      readonly busy: boolean;
      readonly failure?: Problem;
    }
  | {
      readonly kind: 'known';
      readonly seed: ShareLinkSeed;
      readonly sub: MemberSubscription;
      readonly busy: boolean;
      readonly unlock: 'not-needed' | 'needed' | 'done';
      readonly result?: { readonly added: boolean; readonly sentence: string };
      readonly failure?: string;
    }
  | { readonly kind: 'refused'; readonly sub: MemberSubscription };

const FAILED_TITLES: Readonly<Record<JoinFailure, string>> = {
  refused: 'This link was refused',
  unreachable: 'Could not reach the publisher',
  unsupported: 'This browser cannot join',
};

export function JoinScreen({ members, fragment, now, ticker = secondTicker, onShared, onHome }: JoinScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });

  useEffect(() => {
    let live = true;
    void members.begin(fragment).then(begun => {
      if (!live) return;
      if (begun.kind === 'invalid') setPhase({ kind: 'invalid', sentence: begun.sentence });
      else if (begun.kind === 'new') setPhase({ kind: 'ready', seed: begun.seed, oldKey: false });
      else if (begun.subscription.status === 'refused') setPhase({ kind: 'ready', seed: begun.seed, oldKey: true });
      else setPhase({ kind: 'known', seed: begun.seed, sub: begun.subscription, busy: false, unlock: 'not-needed' });
    });
    return () => {
      live = false;
    };
  }, [members, fragment]);

  const clock = useClock(now, ticker, phase.kind === 'passkey' && phase.stage === 'add');

  const join = async (seed: ShareLinkSeed, oldKey: boolean): Promise<void> => {
    setPhase({ kind: 'joining', seed, oldKey });
    const outcome = await members.join(seed);
    if (outcome.kind === 'joined') setPhase({ kind: 'passkey', sub: outcome.subscription, stage: 'add', busy: false });
    else setPhase({ kind: 'join-failed', seed, oldKey, why: outcome.kind, sentence: outcome.sentence });
  };

  const passkeyStep = async (sub: MemberSubscription, stage: 'add' | 'unlock'): Promise<void> => {
    setPhase({ kind: 'passkey', sub, stage, busy: true });
    const attempt = await (stage === 'add' ? members.addPasskey(sub) : members.unlock(sub));
    if (attempt.kind === 'refused') setPhase({ kind: 'refused', sub });
    else if (attempt.kind === 'failed')
      setPhase({ kind: 'passkey', sub, stage, busy: false, failure: attempt.problem });
    else if (stage === 'add') setPhase({ kind: 'passkey', sub, stage: 'unlock', busy: false });
    else onShared(sub.daemonId);
  };

  const redeem = async (seed: ShareLinkSeed, sub: MemberSubscription): Promise<void> => {
    setPhase({ kind: 'known', seed, sub, busy: true, unlock: 'not-needed' });
    const attempt = await members.redeem(sub, seed.code);
    if (attempt.kind === 'refused') {
      setPhase({ kind: 'refused', sub });
      return;
    }
    if (attempt.kind === 'failed') {
      const locked = attempt.problem.kind === 'locked';
      setPhase({
        kind: 'known',
        seed,
        sub,
        busy: false,
        unlock: locked ? 'needed' : 'not-needed',
        ...(locked ? {} : { failure: attempt.problem.sentence }),
      });
      return;
    }
    const view = redeemView(attempt.value);
    setPhase({
      kind: 'known',
      seed,
      sub,
      busy: false,
      unlock: view.kind === 'locked' ? 'needed' : 'not-needed',
      ...(view.kind === 'locked' ? {} : { result: { added: view.kind === 'added', sentence: view.sentence } }),
    });
  };

  const unlockKnown = async (seed: ShareLinkSeed, sub: MemberSubscription): Promise<void> => {
    setPhase({ kind: 'known', seed, sub, busy: true, unlock: 'needed' });
    const attempt = await members.unlock(sub);
    if (attempt.kind === 'refused') setPhase({ kind: 'refused', sub });
    else if (attempt.kind === 'failed')
      setPhase({ kind: 'known', seed, sub, busy: false, unlock: 'needed', failure: attempt.problem.sentence });
    else setPhase({ kind: 'known', seed, sub, busy: false, unlock: 'done' });
  };

  switch (phase.kind) {
    case 'reading':
      return (
        <SharedPage title={JOIN_TITLE}>
          <p className="m-0 text-cell text-muted" role="status">
            {WORKING}
          </p>
        </SharedPage>
      );
    case 'invalid':
      return (
        <SharedPage title={INVALID_TITLE}>
          <FailureLine sentence={phase.sentence} />
          <Button type="button" onClick={onHome} data-join-home="">
            {BACK_TO_START}
          </Button>
        </SharedPage>
      );
    case 'ready':
    case 'joining': {
      const facts = joinFacts(phase.seed);
      const busy = phase.kind === 'joining';
      return (
        <SharedPage title={JOIN_TITLE}>
          <section className="flex min-w-0 flex-col gap-xs" aria-label="Who you are joining" data-join-facts="">
            <p className="m-0 break-words text-cell text-fg">
              Publisher address: <span className="font-mono">{facts.host}</span>
            </p>
            <Fingerprint
              head={facts.fingerprint}
              full={facts.fingerprintFull}
              label="Machine ID, to compare with the owner"
            />
          </section>
          {phase.oldKey ? (
            <p className="m-0 text-cell text-warn" data-join-old-key="">
              {OLD_KEY_NOTE}
            </p>
          ) : null}
          <p className="m-0 text-cell text-muted">{JOIN_NOTHING_SENT}</p>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void join(phase.seed, phase.oldKey)}
            data-join-button=""
          >
            {busy ? JOINING : JOIN_BUTTON}
          </Button>
          {busy ? (
            <p className="m-0 text-cell text-muted" role="status">
              {JOINING}
            </p>
          ) : null}
        </SharedPage>
      );
    }
    case 'join-failed':
      return (
        <SharedPage title={FAILED_TITLES[phase.why]}>
          <FailureLine sentence={phase.sentence} />
          <div className="flex flex-wrap gap-xs">
            {phase.why === 'refused' ? null : (
              <Button
                type="button"
                variant="primary"
                onClick={() => void join(phase.seed, phase.oldKey)}
                data-join-again-try=""
              >
                {TRY_AGAIN}
              </Button>
            )}
            <Button type="button" onClick={onHome} data-join-home="">
              {BACK_TO_START}
            </Button>
          </div>
        </SharedPage>
      );
    case 'passkey': {
      const { sub } = phase;
      const countdown = passkeyWindow(sub.passkeyWindowEndsAt, clock);
      const closed = phase.stage === 'add' && (!countdown.open || phase.failure?.kind === 'window-closed');
      const heading = passkeyHeading(sub.memberLabel, sub.ownLabel);
      if (closed)
        return (
          <SharedPage title={heading}>
            <FailureLine sentence={WINDOW_CLOSED_SENTENCE} />
            <JoinAgain />
            <Button type="button" onClick={onHome} data-join-home="">
              {BACK_TO_START}
            </Button>
          </SharedPage>
        );
      const again = phase.failure !== undefined && phase.failure.kind !== 'window-closed';
      return (
        <SharedPage title={heading}>
          <p className="m-0 text-cell text-fg">{PASSKEY_EXPLAIN}</p>
          {phase.stage === 'add' ? (
            <>
              <p
                className={countdown.urgent ? 'm-0 text-cell font-semibold text-err' : 'm-0 text-cell text-fg'}
                aria-live="off"
                data-passkey-countdown=""
                data-urgent={countdown.urgent ? '' : undefined}
              >
                {countdown.sentence}
              </p>
              <p className="sr-only" role="status">
                {windowAnnouncement(countdown)}
              </p>
            </>
          ) : (
            <p className="m-0 flex items-center gap-2 text-cell text-ok" role="status" data-passkey-added="">
              <ShieldCheck size={16} aria-hidden="true" />
              {PASSKEY_ADDED}
            </p>
          )}
          {phase.failure === undefined ? null : <FailureLine sentence={phase.failure.sentence} />}
          <Button
            type="button"
            variant="primary"
            disabled={phase.busy}
            onClick={() => void passkeyStep(sub, phase.stage)}
            data-passkey-step={phase.stage}
          >
            {phase.busy ? WORKING : again ? TRY_AGAIN : phase.stage === 'add' ? PASSKEY_BUTTON : UNLOCK_BUTTON}
          </Button>
        </SharedPage>
      );
    }
    case 'known': {
      const { seed, sub } = phase;
      const { result } = phase;
      return (
        <SharedPage title={`You are already in ${revealHidden(sub.ownLabel)}`}>
          {result === undefined ? (
            <>
              {phase.unlock === 'needed' ? (
                <p className="m-0 text-cell text-fg" data-known-unlock-first="">
                  {UNLOCK_THEN_LINK}
                </p>
              ) : null}
              {phase.unlock === 'done' ? (
                <p className="m-0 text-cell text-ok" role="status">
                  {UNLOCKED_THEN_LINK}
                </p>
              ) : null}
              {phase.failure === undefined ? null : <FailureLine sentence={phase.failure} />}
              {phase.unlock === 'needed' ? (
                <Button
                  type="button"
                  variant="primary"
                  disabled={phase.busy}
                  onClick={() => void unlockKnown(seed, sub)}
                  data-known-unlock=""
                >
                  {phase.busy ? WORKING : UNLOCK_BUTTON}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  disabled={phase.busy}
                  onClick={() => void redeem(seed, sub)}
                  data-known-redeem=""
                >
                  {phase.busy ? ADDING : ADD_FROM_LINK}
                </Button>
              )}
            </>
          ) : result.added ? (
            <>
              <p className="m-0 text-cell text-ok" role="status" data-known-result="added">
                {result.sentence}
              </p>
              <Button type="button" variant="primary" onClick={() => onShared(sub.daemonId)} data-join-open-shared="">
                {OPEN_SHARED}
              </Button>
            </>
          ) : (
            <>
              <FailureLine sentence={result.sentence} />
              <Button type="button" onClick={onHome} data-join-home="">
                {BACK_TO_START}
              </Button>
            </>
          )}
        </SharedPage>
      );
    }
    case 'refused':
      return (
        <SharedPage title={revealHidden(phase.sub.ownLabel)}>
          <AccessRefused
            label={revealHidden(phase.sub.ownLabel)}
            level={2}
            onTryAgain={async () => {
              const attempt = await members.tryAgain(phase.sub);
              if (attempt.kind === 'ok') onShared(phase.sub.daemonId);
              return attempt;
            }}
            onForget={async () => {
              await members.forget(phase.sub.daemonId);
              onHome();
            }}
          />
        </SharedPage>
      );
  }
}
