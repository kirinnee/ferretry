/**
 * Step `permission`: Auto mode or Skip permissions. The card that is selected on opening is the config value (default
 * `skip`, owner !A525). A write changes ONLY `permissionMode` in `config/harness-codex.yaml`, through the config route and
 * the shared one-key editor, so every other key and comment stays. Choosing Auto (the narrower mode) writes at once.
 * Choosing Skip from Auto does NOT write: it shows in full what Skip allows (no approvals, no sandbox, deleting files, the
 * real flag) and waits for an explicit confirm, so the consequence is on screen BEFORE the press that submits it. While that
 * confirm is open the page is `busy`, so Next cannot answer the step by default. A file the page cannot read safely (withheld by
 * the daemon, or not valid YAML) shows the mode as unknown and writes nothing: "Change this at the machine: <file>". The person's
 * own choice is not held; if the daemon holds it anyway the page says so instead of showing it as saved. The dangerous-rm
 * waiver is a separate Settings switch and is not offered here.
 */
import { Button, ChoiceCards } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { useEffect, useState } from 'react';
import {
  AUTO_WORDS,
  type ConfigFile,
  type OnboardingClient,
  type PermissionMode,
  SKIP_FLAG,
  SKIP_LEAD,
  SKIP_TAIL,
  changeAtMachineWords,
  currentMode,
  readConfig,
  refusalWords,
  writeMode,
} from './onboarding-api.ts';

const OPTIONS = [
  { id: 'auto', title: 'Auto mode', line: AUTO_WORDS },
  { id: 'skip', title: 'Skip permissions', line: 'Codex never asks. Read what that allows below.' },
] as const;

const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';
const CONFIRMING = 'Confirm or cancel Skip permissions';

/** The full consequence of Skip, drawn before anything is written and while it is the saved mode. */
function SkipWarning() {
  return (
    <p className="m-0 max-w-xl border-l-2 border-warn pl-3 text-ui leading-base text-fg" data-permission-words="skip">
      {SKIP_LEAD}{' '}
      <code className="rounded bg-surface-2 px-1 text-cell [overflow-wrap:anywhere] md:whitespace-nowrap">
        {SKIP_FLAG}
      </code>
      {SKIP_TAIL}
    </p>
  );
}

export function PermissionPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** The mode the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [mode, setMode] = useState<PermissionMode | null>('skip');
  /** Skip was chosen from Auto and is waiting for the explicit confirm. */
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    readConfig(client)
      .then(read => {
        if (!current) return;
        setFile(read);
        setMode(currentMode(read));
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

  const write = async (chosen: PermissionMode): Promise<void> => {
    if (file === null || mode === null) return;
    setSaving(true);
    setNote(null);
    step.busy('Saving…');
    try {
      const result = await writeMode(client, file, chosen);
      const fresh = await readConfig(client);
      setFile(fresh);
      setMode(currentMode(fresh) ?? chosen);
      setConfirming(false);
      if (result === 'held') setNote(HELD_WORDS);
      else step.done();
    } catch (cause) {
      setNote(refusalWords(cause));
      step.busy(confirming ? CONFIRMING : null);
      setSaving(false);
      return;
    }
    step.busy(null);
    setSaving(false);
  };

  const choose = (next: string): void => {
    if (file === null || mode === null) return;
    if (next === 'skip') {
      // Skip is the wider mode: select it and show the consequence, but write nothing until the person confirms.
      if (mode === 'skip') return;
      setConfirming(true);
      setNote(null);
      step.busy(CONFIRMING);
      return;
    }
    // Auto narrows what Codex may do, so it needs no extra confirm.
    if (confirming) {
      setConfirming(false);
      step.busy(null);
    }
    if (mode !== 'auto') void write('auto');
  };

  const cancel = (): void => {
    setConfirming(false);
    step.busy(null);
  };

  const shown: PermissionMode | null = confirming ? 'skip' : mode;
  return (
    <section aria-label="Codex permissions" className="flex flex-col gap-3" data-codex-step="permission">
      <ChoiceCards
        label="How Codex asks before it acts"
        options={OPTIONS}
        value={file === null || shown === null ? null : shown}
        disabled={file === null || mode === null || saving}
        onChange={choose}
      />
      {file !== null && mode === null ? (
        <p role="alert" className="m-0 max-w-xl text-cell text-warn" data-permission-unknown="">
          Codex&apos;s permission mode can&apos;t be read here, so it is not changed. {changeAtMachineWords(file)}
        </p>
      ) : null}
      {file !== null && shown === 'skip' ? <SkipWarning /> : null}
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            className="min-h-11 py-3"
            disabled={saving}
            data-permission-confirm=""
            onClick={() => void write('skip')}
          >
            Yes, let Codex skip permissions
          </Button>
          <Button type="button" className="min-h-11 py-3" disabled={saving} data-permission-cancel="" onClick={cancel}>
            Keep Auto mode
          </Button>
        </div>
      ) : null}
      {note === null ? null : (
        <p role="alert" className="m-0 text-cell text-warn" data-permission-note="">
          {note}
        </p>
      )}
    </section>
  );
}
