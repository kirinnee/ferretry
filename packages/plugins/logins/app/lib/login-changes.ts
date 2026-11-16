/**
 * One change to a login, from a click to the machine: stage ONE intent at Logins' own route
 * (`POST /v1/logins/changes`), which writes nothing and answers with its preview, then apply exactly that change
 * (`POST /v1/logins/changes/:changeId/apply`). A caller off the machine confirms with a passkey step-up: the daemon
 * refuses the request, the carrier asks for the passkey and sends the same request once more, so neither call needs
 * anything extra from this module.
 *
 * Nothing throws: each call answers `applied` or `refused`, and a refusal is ONE sentence a person can read, in the
 * daemon's own words where it gave some. The change is the daemon's to derive: a caller names an intent, never a file.
 */
import { type ChangeAuthority, useChangeAuthority } from '@ferretry/app/ui';
import { useCallback, useState } from 'react';
import {
  type LoginChange,
  type LoginChangeOutcome,
  LoginChangeOutcomeSchema,
  LoginChangeSchema,
  type LoginChangeView,
  LoginChangeViewSchema,
} from '../../contract/index.ts';
import { type LoginsClient, refusalSentence } from './client.ts';

const STAGE_ROUTE = 'POST /v1/logins/changes' as const;
const APPLY_ROUTE = 'POST /v1/logins/changes/:changeId/apply' as const;

/** Stage one change. Nothing is written: the answer is the preview a person approves. */
const stageLoginChange = async (client: LoginsClient, change: LoginChange): Promise<LoginChangeView> =>
  LoginChangeViewSchema.parse(await client.call(STAGE_ROUTE, { body: LoginChangeSchema.parse(change) }));

/** Apply exactly the change that was previewed. */
const applyLoginChange = async (client: LoginsClient, changeId: string): Promise<LoginChangeOutcome> =>
  LoginChangeOutcomeSchema.parse(await client.call(APPLY_ROUTE, { params: { changeId }, body: {} }));

type ChangeResult =
  | { readonly kind: 'applied'; readonly staged: LoginChangeView; readonly outcome: LoginChangeOutcome }
  | { readonly kind: 'refused'; readonly sentence: string };

type StageResult =
  | { readonly kind: 'staged'; readonly staged: LoginChangeView }
  | Extract<ChangeResult, { kind: 'refused' }>;

/** What a finished change says to the person: nothing for a plain apply, the owner's hold or a failed sign-out otherwise. */
function outcomeSentence(outcome: LoginChangeOutcome): string | null {
  switch (outcome.outcome) {
    case 'applied':
    case 'signed-out':
      return null;
    case 'held':
      return `Saved, but this loosens something, so the owner has to confirm it before it takes effect. The tighter version stays in effect until then: ${outcome.sentences.join('; ')}.`;
    case 'sign-out-failed':
      return `Could not sign out: ${outcome.reason}`;
  }
}

export interface LoginChanges {
  /** `null` while it is being read. */
  readonly authority: ChangeAuthority | null;
  readonly busy: boolean;
  /** The last refusal, as one sentence, or `null`. */
  readonly refusal: string | null;
  /** Stage and apply one change. */
  readonly apply: (change: LoginChange) => Promise<ChangeResult>;
  /** Stage only, for a confirm card that shows the daemon's consequences first. */
  readonly stage: (change: LoginChange) => Promise<StageResult>;
  /** Apply a change {@link stage} returned. */
  readonly applyStaged: (staged: LoginChangeView) => Promise<ChangeResult>;
  readonly clear: () => void;
  /** Show a sentence the caller worded where a change's refusal shows. */
  readonly refuse: (sentence: string) => void;
}

/** The change state for one machine. The client is per daemon, so another machine is another client. */
export function useLoginChanges(client: LoginsClient): LoginChanges {
  const authority = useChangeAuthority(client);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const run = useCallback(
    async <R extends ChangeResult | StageResult>(
      work: () => Promise<R>,
    ): Promise<R | Extract<ChangeResult, { kind: 'refused' }>> => {
      setBusy(true);
      setRefusal(null);
      try {
        const result = await work();
        if (result.kind === 'refused') setRefusal(result.sentence);
        else if ('outcome' in result) setRefusal(outcomeSentence(result.outcome));
        return result;
      } catch (error) {
        const sentence = refusalSentence(error);
        setRefusal(sentence);
        return { kind: 'refused', sentence };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const applyStaged = useCallback(
    (staged: LoginChangeView): Promise<ChangeResult> =>
      run(async () => ({ kind: 'applied', staged, outcome: await applyLoginChange(client, staged.id) })),
    [client, run],
  );

  return {
    authority,
    busy,
    refusal,
    apply: change =>
      run(async () => {
        const staged = await stageLoginChange(client, change);
        return { kind: 'applied', staged, outcome: await applyLoginChange(client, staged.id) } as const;
      }),
    stage: change => run(async () => ({ kind: 'staged', staged: await stageLoginChange(client, change) }) as const),
    applyStaged,
    clear: () => setRefusal(null),
    refuse: sentence => setRefusal(sentence),
  };
}
