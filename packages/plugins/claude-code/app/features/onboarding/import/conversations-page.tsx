/**
 * "Conversations": whether Ferretry may SHOW the conversations Claude Code keeps on this computer (`hostHistory`, default
 * on). It is asked in every import mode. One way: Ferretry reads them and never changes them; a conversation is copied
 * only when the person continues it here. Turning it off stops the READING and deletes nothing in `~/.claude`.
 *
 * Two stacked cards. A pick is NOT a write (ChoiceCards moves AND selects on the arrow keys): only Next saves it
 * (`useConfigChoice`, contract rule 8), and it writes exactly one key.
 */
import { Button, ChoiceCards, type ChoiceOption, StepDemo } from '@ferretry/app';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import { useConfigChoice } from '../config-choice.ts';
import { ConversationsDemo } from '../demos.tsx';
import type { StepPageProps } from '../props.ts';
import { historyRead, withHostHistory } from './history-config.ts';

/** The owner's words (add 6): binding. */
export const ONE_WAY =
  'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.';

type Choice = 'on' | 'off';

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'on', title: 'Show them here', line: 'Shown in Ferretry.' },
  { id: 'off', title: 'Don’t show them', line: 'Not read. Nothing is deleted.' },
];

const choiceOf = (text: string, state?: string): Choice | null => {
  const found = historyRead(text, state);
  return found.kind === 'unknown' ? null : found.kind;
};
const withChoice = (text: string, choice: Choice): string => withHostHistory(text, choice === 'on');

export function ConversationsPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const { saved, shown, pick, where, note, retry } = useConfigChoice<Choice>({
    client,
    step,
    read: choiceOf,
    write: withChoice,
  });

  if (saved === null) return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.conversations">
      {saved === 'unknown' ? (
        <p className="cc-step__line" data-mode-unknown="">
          The current setting is unknown: this page cannot read it safely. Change it at the machine: {where}
        </p>
      ) : (
        <>
          <ChoiceCards
            label="Conversations"
            layout="stack"
            options={OPTIONS}
            value={shown ?? saved}
            onChange={next => pick(next as Choice)}
          />
          <StepDemo>
            <ConversationsDemo key={shown ?? saved} show={(shown ?? saved) === 'on'} />
          </StepDemo>
          <p className="cc-step__line" data-conversations-one-way="">
            {ONE_WAY}
          </p>
        </>
      )}
      {note === null ? null : (
        <div className="cc-actions">
          <p role="alert" className="cc-step__line">
            {note}
          </p>
          <Button onClick={retry}>Try again</Button>
        </div>
      )}
    </div>
  );
}
