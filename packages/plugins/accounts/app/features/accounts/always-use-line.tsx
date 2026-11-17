/**
 * "ALWAYS USE FOR <PROJECT>": what Accounts draws in the Vault's `vault.input-settled` slot, under an input card the owner
 * just settled by tapping a saved account (docs/input-requests.md, "Always use").
 *
 * One quiet button. The owner's tap on it is the permission: nothing is written until then, and what it writes is exactly
 * {@link alwaysUseFor}'s body (`PUT /v1/accounts/defaults`, the owner route, in effect at once as the owner's own act).
 * What the Vault hands over is ids and keys the card already held; whether the line is offered, and for which account, is
 * decided from the DAEMON's own account list, so a tap that named another account, a sign-in the daemon does not match to
 * this place, a card with no project, or an account that already is the project's default draws NOTHING. A failed read
 * draws nothing too: the card is complete without it.
 *
 * While the line is on offer the card keeps its view (`hold(true)`); once it is written, and if the line goes away, it lets
 * go (`hold(false)`). A refusal is said in fixed words and never echoes anything.
 */

import { isInputSettledSlotProps } from '@ferretry/core-vault/contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AlwaysUseWords,
  alwaysUseExplainParts,
  alwaysUseFailureWords,
  alwaysUseFor,
  alwaysUseSavedParts,
} from '../../lib/always-use.ts';
import { type AccountsClient, putAccountDefault, readAccounts } from './accounts-api.ts';

export interface AlwaysUseLineProps {
  /** The Accounts client of the machine the card is on. */
  readonly client: AccountsClient;
  /** What the slot handed the panel: the shell's `subject` and the card's props, none of them trusted. */
  readonly slot: unknown;
}

type Phase = 'idle' | 'writing' | 'saved';

/**
 * A project's name is one unit: a name like `demo-project` must not break after its hyphen ("…in demo-" / "project.").
 * It is an inline box, so it moves to the next line whole, and only a name wider than the line itself breaks inside.
 * Punctuation right after the name stays with it, so a lone "." never starts a line.
 */
function ProjectName({ name, glued = '' }: { readonly name: string; readonly glued?: string }) {
  return (
    <span className="inline-block max-w-full break-words align-bottom" data-input-always-project="">
      {name}
      {glued}
    </span>
  );
}

/** A sentence with the project's name kept whole. */
function Sentence({ words }: { readonly words: AlwaysUseWords }) {
  const glued = /^[.,;:!?]*/u.exec(words.after)?.[0] ?? '';
  return (
    <>
      {words.before}
      <ProjectName glued={glued} name={words.project} />
      {words.after.slice(glued.length)}
    </>
  );
}

export function AlwaysUseLine({ client, slot }: AlwaysUseLineProps) {
  const props = useMemo(() => (isInputSettledSlotProps(slot) ? slot : undefined), [slot]);
  const ferret = props?.ferret;
  const request = props?.request;
  const [list, setList] = useState<Awaited<ReturnType<typeof readAccounts>> | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  // The card's hold callback rides in the props; it is called through a ref so a new function never re-runs the effects.
  const hold = useRef(props?.hold);
  hold.current = props?.hold;

  useEffect(() => {
    setList(undefined);
    setPhase('idle');
    setFailure(null);
    if (ferret === undefined || request === undefined) return;
    let current = true;
    void readAccounts(client).then(
      read => {
        if (current) setList(read);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client, ferret, request]);

  const always = useMemo(
    () => (props === undefined || list === undefined ? undefined : alwaysUseFor(props, list)),
    [props, list],
  );

  // On offer and not yet written: the card keeps its view. Done, gone or unmounted: it lets go.
  const offering = always !== undefined && phase !== 'saved';
  useEffect(() => {
    if (!offering) return;
    hold.current?.(true);
    return () => hold.current?.(false);
  }, [offering]);

  if (always === undefined) return null;

  const write = async (): Promise<void> => {
    setPhase('writing');
    setFailure(null);
    try {
      await putAccountDefault(client, always.body);
      setPhase('saved');
    } catch (cause) {
      setPhase('idle');
      setFailure(alwaysUseFailureWords(cause));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-input-always="">
      {phase === 'saved' ? (
        <p className="m-0 text-meta text-ok" data-input-always-saved="" role="status">
          <Sentence words={alwaysUseSavedParts(always)} />
        </p>
      ) : (
        <>
          <button
            className="kt-btn min-h-[44px] self-start"
            data-input-always-button=""
            disabled={phase === 'writing'}
            onClick={() => void write()}
            type="button"
          >
            <span>
              Always use for <ProjectName name={always.project} />
            </span>
          </button>
          <p className="m-0 text-meta text-muted">
            <Sentence words={alwaysUseExplainParts(always)} />
          </p>
        </>
      )}
      {failure === null ? null : (
        <p className="m-0 text-meta text-err" data-input-always-failure="" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
