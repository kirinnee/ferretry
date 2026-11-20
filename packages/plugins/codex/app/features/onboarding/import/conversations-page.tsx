/**
 * Step `conversations`, asked in every import mode: show the conversations from the person's own terminal Codex here, or keep
 * them out. It reads the current value back from the config file when it opens (so a reload loses nothing, and it never needs
 * `importMode`), and it NEVER writes on a selection: the cards only pick, and the one write is the explicit "Save" press. While a
 * pick is unsaved the page is `busy`, so Next cannot answer the step by default.
 *
 * The wording is the owner's: one way, read and never changed, and a conversation is copied only when it is continued here.
 */
import { Button, ChoiceCards } from '@ferretry/app';
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
const UNSAVED = 'Save your choice, or leave it as it is';
const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

const OPTIONS = [
  { id: 'on', title: 'Show them here', line: 'The conversations from your terminal Codex appear in Ferretry' },
  { id: 'off', title: 'Keep them out', line: 'Ferretry does not read your terminal Codex conversations' },
] as const;

export function ConversationsPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** What the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [saved, setSaved] = useState<boolean | null>(true);
  /** The card the person is on; differs from `saved` until Save. */
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
  const pending = pick !== null && pick !== saved;

  const choose = (next: string): void => {
    if (file === null || saved === null) return;
    const on = next === 'on';
    setPick(on);
    setNote(null);
    step.busy(on === saved ? null : UNSAVED);
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
      step.busy(UNSAVED);
      setSaving(false);
      return;
    }
    step.busy(null);
    setSaving(false);
  };

  return (
    <section aria-label="Codex conversations" className="flex max-w-xl flex-col gap-3" data-codex-step="conversations">
      <p className="m-0 text-ui text-fg" data-conversations-words="">
        {ONE_WAY_WORDS}
      </p>
      <ChoiceCards
        label="Your terminal Codex conversations"
        options={OPTIONS}
        value={file === null || shown === null ? null : shown ? 'on' : 'off'}
        disabled={file === null || saved === null || saving}
        onChange={choose}
      />
      {file !== null && saved === null ? (
        <p role="alert" className="m-0 text-cell text-warn" data-conversations-unknown="">
          This setting can&apos;t be read here, so it is not changed. {changeAtMachineWords(file)}
        </p>
      ) : null}
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            className="min-h-11 py-3"
            disabled={saving}
            data-conversations-save=""
            onClick={() => void save()}
          >
            Save
          </Button>
          <Button
            type="button"
            className="min-h-11 py-3"
            disabled={saving}
            data-conversations-cancel=""
            onClick={() => {
              setPick(null);
              step.busy(null);
            }}
          >
            Leave it as it is
          </Button>
        </div>
      ) : null}
      {note === null ? null : (
        <p role="alert" className="m-0 text-cell text-warn" data-conversations-note="">
          {note}
        </p>
      )}
    </section>
  );
}
