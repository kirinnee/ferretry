/**
 * Step `permission`: Auto mode or Skip permissions. The card that is selected on opening is the config value (default
 * `skip`, owner !A525). A press writes ONLY `permissionMode` in `config/harness-codex.yaml`, through the config route. It says
 * plainly what Skip allows and names the real flag. The person's own choice is not held; if the daemon holds it anyway the
 * page says so instead of showing it as saved. The dangerous-rm waiver is a separate Settings switch and is not offered here.
 */
import { ChoiceCards } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { useEffect, useState } from 'react';
import {
  AUTO_WORDS,
  type ConfigFile,
  type OnboardingClient,
  type PermissionMode,
  SKIP_WORDS,
  modeOf,
  readConfig,
  refusalWords,
  writeMode,
} from './onboarding-api.ts';

const OPTIONS = [
  { id: 'auto', title: 'Auto mode', line: AUTO_WORDS },
  { id: 'skip', title: 'Skip permissions', line: 'Codex never asks. Read what that allows below.' },
] as const;

const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

export function PermissionPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [mode, setMode] = useState<PermissionMode>('skip');
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    readConfig(client)
      .then(read => {
        if (!current) return;
        setFile(read);
        setMode(modeOf(read.text));
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

  const choose = async (next: string): Promise<void> => {
    const chosen: PermissionMode = next === 'auto' ? 'auto' : 'skip';
    if (file === null || chosen === mode) return;
    setSaving(true);
    setNote(null);
    step.busy('Saving…');
    try {
      const result = await writeMode(client, file, chosen);
      setMode(chosen);
      setFile(await readConfig(client));
      if (result === 'held') setNote(HELD_WORDS);
      else step.done();
    } catch (cause) {
      setNote(refusalWords(cause));
    } finally {
      step.busy(null);
      setSaving(false);
    }
  };

  return (
    <section aria-label="Codex permissions" className="flex flex-col gap-3" data-codex-step="permission">
      <ChoiceCards
        label="How Codex asks before it acts"
        options={OPTIONS}
        value={file === null ? null : mode}
        disabled={file === null || saving}
        onChange={next => void choose(next)}
      />
      {file === null ? null : (
        <p className="m-0 max-w-xl text-cell text-muted" data-permission-words={mode}>
          {mode === 'skip' ? SKIP_WORDS : AUTO_WORDS}
        </p>
      )}
      {note === null ? null : (
        <p role="alert" className="m-0 text-cell text-warn" data-permission-note="">
          {note}
        </p>
      )}
    </section>
  );
}
