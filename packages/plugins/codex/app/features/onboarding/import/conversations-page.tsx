/**
 * Step `conversations`, asked in every import mode (r11 O5): show the conversations from the person's own terminal Codex
 * here, or keep them out. Two stacked cards on the left, nothing to press on the page: the footer's Next saves the pick.
 *
 * It reads the current value back from the config file when it opens (so a reload loses nothing, and it never needs
 * `importMode`); the card selected on opening is that value. A pick NEVER writes: when it differs from what is saved the
 * page registers `host.commit` (contract rule 8), and only a real Next press runs it, under the shell's "Saving…". A pick
 * that equals the saved value clears the commit, so Next writes nothing. A refusal, or a change the daemon HOLDS for the
 * owner's confirmation, rejects the commit: the footer says why, the page stays, Next can try again.
 *
 * The wording is the owner's: one way, read and never changed, and a conversation is copied only when it is continued here.
 */
import { ChoiceCards, type ChoiceOption, StepDemo } from '@ferretry/app';
import { StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConfigFile,
  type OnboardingClient,
  type StepHost,
  changeAtMachineWords,
  readConfig,
  refusalWords,
} from '../onboarding-api.ts';
import { ConversationsDemo } from '../demos.tsx';
import { currentHistory, writeHistory } from './history-config.ts';

export const ONE_WAY_WORDS = 'One way: Ferretry only reads them; one is copied when you continue it here.';
const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

type Choice = 'on' | 'off';

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'on', title: 'Show them here', line: 'Your Codex history appears here.' },
  { id: 'off', title: 'Don’t show them', line: 'Ferretry will not read it.' },
];
const wordOf = (on: boolean): Choice => (on ? 'on' : 'off');

export function ConversationsPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** What the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [saved, setSaved] = useState<boolean | null>(true);
  /** The card the person is on; differs from `saved` until Next writes it. */
  const [pick, setPick] = useState<boolean | null>(null);
  /** True from the moment Next starts the write until the daemon answers: the pick the footer captured is the one saved. */
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // What a commit reads is the file as it is NOW, never a stale copy from the render that registered it.
  const latest = useRef<ConfigFile | null>(null);
  latest.current = file;

  useEffect(() => {
    let current = true;
    readConfig(client)
      .then(read => {
        if (!current) return;
        setFile(read);
        setSaved(currentHistory(read));
      })
      .catch((cause: unknown) => {
        if (current) setNote(refusalWords(cause));
      })
      .finally(() => {
        if (current) step.ready();
      });
    return () => {
      current = false;
    };
  }, [client, step]);

  const save = useCallback(
    (chosen: boolean) => async (): Promise<void> => {
      const now = latest.current;
      if (now === null) throw new Error('The conversations setting has not been read yet.');
      setSaving(true);
      try {
        const result = await writeHistory(client, now, chosen).catch((cause: unknown) => {
          throw new Error(refusalWords(cause));
        });
        const fresh = await readConfig(client);
        setFile(fresh);
        // A change the daemon holds for the owner is not saved: say so, stay, and let Next try again.
        if (result === 'held') throw new Error(HELD_WORDS);
        setSaved(currentHistory(fresh) ?? chosen);
        setPick(null);
      } finally {
        setSaving(false);
      }
    },
    [client],
  );

  const choose = (next: string): void => {
    if (file === null || saved === null) return;
    const chosen = next === 'on';
    setNote(null);
    if (chosen === saved) {
      setPick(null);
      step.commit(null);
    } else {
      setPick(chosen);
      step.commit(save(chosen));
    }
  };

  const shown = pick ?? saved;
  return (
    <StepBody step="codex.conversations" label="Codex conversations" data-codex-step="conversations">
      {file !== null && saved === null ? (
        <StepLine role="alert" data-conversations-unknown="">
          The current setting is unknown: this page cannot read it safely. {changeAtMachineWords(file)}
        </StepLine>
      ) : (
        <ChoiceCards
          label="Conversations"
          layout="stack"
          options={OPTIONS}
          value={file === null || shown === null ? null : wordOf(shown)}
          disabled={file === null || saved === null || saving}
          onChange={choose}
        />
      )}
      {file === null || shown === null ? null : (
        <StepDemo>
          <ConversationsDemo on={shown} />
        </StepDemo>
      )}
      <StepLine data-conversations-words="">{ONE_WAY_WORDS}</StepLine>
      {note === null ? null : (
        <StepLine role="alert" data-conversations-note="">
          {note}
        </StepLine>
      )}
    </StepBody>
  );
}
