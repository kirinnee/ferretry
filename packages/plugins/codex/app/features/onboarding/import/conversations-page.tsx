/**
 * Step `conversations`, asked in every import mode: show the conversations from the person's own terminal Codex here, or keep
 * them out. It reads the current value back from the config file when it opens (so a reload loses nothing, and it never needs
 * `importMode`), and it NEVER writes on a selection: the cards only pick, and the one write is the explicit "Use …" press
 * (or "Keep …", which writes nothing and answers the step). A pick waiting for its press holds nothing, and the page says
 * that Next keeps what is saved now. The same page, words and buttons as Claude Code's.
 *
 * The wording is the owner's: one way, read and never changed, and a conversation is copied only when it is continued here.
 */
import { Button, ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { StepActions, StepBody, StepConfirm, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useEffect, useState } from 'react';
import {
  type ConfigFile,
  type OnboardingClient,
  type StepHost,
  changeAtMachineWords,
  readConfig,
  refusalWords,
} from '../onboarding-api.ts';
import { currentHistory, writeHistory } from './history-config.ts';

export const ONE_WAY_WORDS =
  'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.';
const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

type Choice = 'on' | 'off';

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'on', title: 'Show them here', line: 'Your terminal’s Codex conversations appear in Ferretry.' },
  { id: 'off', title: 'Don’t show them', line: 'Ferretry will not read them. Nothing on your computer is deleted.' },
];
const USE: Readonly<Record<Choice, string>> = { on: 'Use: show them here', off: 'Use: don’t show them' };
const KEEP: Readonly<Record<Choice, string>> = { on: 'Keep showing them', off: 'Keep them hidden' };
const wordOf = (on: boolean): Choice => (on ? 'on' : 'off');

export function ConversationsPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** What the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [saved, setSaved] = useState<boolean | null>(true);
  /** The card the person is on; differs from `saved` until Use. */
  const [pick, setPick] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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

  const shown = pick ?? saved;
  const pending = pick !== null && saved !== null && pick !== saved;

  const keep = (): void => {
    if (saved === null) return;
    setNote(null);
    setPick(null);
    step.done();
  };

  const save = async (): Promise<void> => {
    if (file === null || pick === null || saved === null) return;
    setSaving(true);
    setNote(null);
    step.busy('Saving…');
    try {
      const result = await writeHistory(client, file, pick);
      const fresh = await readConfig(client);
      setFile(fresh);
      setSaved(currentHistory(fresh) ?? pick);
      setPick(null);
      if (result === 'held') setNote(HELD_WORDS);
      else step.done();
    } catch (cause) {
      setNote(refusalWords(cause));
    } finally {
      setSaving(false);
      step.busy(null);
    }
  };

  return (
    <StepBody step="codex.conversations" label="Codex conversations" data-codex-step="conversations">
      <StepLine>Show the conversations you already have in your terminal’s Codex?</StepLine>
      <StepLine data-conversations-words="">{ONE_WAY_WORDS}</StepLine>
      {file !== null && saved === null ? (
        <StepLine role="alert" data-conversations-unknown="">
          The current setting is unknown: this page cannot read it safely. {changeAtMachineWords(file)}
        </StepLine>
      ) : (
        <ChoiceCards
          label="Conversations"
          options={OPTIONS}
          value={file === null || shown === null ? null : wordOf(shown)}
          disabled={file === null || saved === null || saving}
          onChange={next => {
            if (file === null || saved === null) return;
            setPick(next === 'on');
            setNote(null);
          }}
        />
      )}
      {pending && pick !== null && saved !== null ? (
        <StepConfirm data-conversations-confirm="">
          <StepLine role="note">Nothing is saved until you press the button. Next keeps what is saved now.</StepLine>
          <StepActions>
            <Button variant="primary" disabled={saving} data-conversations-save="" onClick={() => void save()}>
              {USE[wordOf(pick)]}
            </Button>
            <Button disabled={saving} data-conversations-cancel="" onClick={keep}>
              {KEEP[wordOf(saved)]}
            </Button>
          </StepActions>
        </StepConfirm>
      ) : null}
      {saving ? <StepLine role="status">Saving…</StepLine> : null}
      {note === null ? null : (
        <StepLine role="alert" data-conversations-note="">
          {note}
        </StepLine>
      )}
    </StepBody>
  );
}
