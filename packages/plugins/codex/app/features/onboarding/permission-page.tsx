/**
 * Step `permission`: Auto mode or Skip permissions. The card that is selected on opening is the config value (default
 * `skip`, owner !A525). A write changes ONLY `permissionMode` in `config/harness-codex.yaml`, through the config route and
 * the shared one-key editor, so every other key and comment stays.
 *
 * A pick is NOT a write: moving over the cards (arrow keys included) only selects. The page then says in full what the selected
 * mode means (for Skip: no approvals, no sandbox, deleting files, the real flag) and offers one explicit "Use …" button; only that
 * press writes. While a pick differs from the saved mode the page holds `busy`, so the shell's Next cannot record "done" over a
 * daemon still on the old mode: the person either presses "Use …" (writes, then done) or "Keep …" (done, no write), or moves back
 * to the saved card. A file the page cannot read safely (withheld by the daemon, or not valid YAML) shows the mode as unknown and
 * writes nothing: "Change this at the machine: <file>". If the daemon holds the change anyway the page says so instead of showing
 * it as saved. The dangerous-rm waiver is a separate Settings switch and is not offered here. The same page, words, demo and
 * buttons as Claude Code's.
 */
import { Button, ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { PermissionDemo, StepActions, StepBody, StepConfirm, StepLine } from '@ferretry/plugin-runtimes/import-kit';
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

const SKIP_WORDS = `${SKIP_LEAD} ${SKIP_FLAG}${SKIP_TAIL}`;

/** What each mode means, said in full before the press that writes it. */
const CONSEQUENCE: Readonly<Record<PermissionMode, { readonly button: string; readonly text: string }>> = {
  auto: { button: 'Use Auto mode', text: AUTO_WORDS },
  skip: { button: 'Use Skip permissions', text: SKIP_WORDS },
};
const KEEP: Readonly<Record<PermissionMode, string>> = { auto: 'Keep Auto mode', skip: 'Keep Skip permissions' };

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'auto', title: 'Auto mode', line: AUTO_WORDS },
  { id: 'skip', title: 'Skip permissions', line: `${SKIP_WORDS.replace(/\.$/u, '')}.` },
];

/** Why Next is locked while a pick has not been written or dropped. */
const HOLD = 'Press “Use …” or “Keep …” to continue';
const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

const isMode = (value: string): value is PermissionMode => value === 'auto' || value === 'skip';

export function PermissionPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** The mode the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [mode, setMode] = useState<PermissionMode | null>('skip');
  /** The card selected but not yet written. */
  const [picked, setPicked] = useState<PermissionMode | null>(null);
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

  const shown: PermissionMode | null = picked ?? mode;
  const pending = picked !== null && mode !== null && picked !== mode;

  // Hold Next while a pick differs from the saved mode; release it when the pick is written, kept or withdrawn. A save in flight
  // owns `busy` itself ("Saving…").
  useEffect(() => {
    if (saving) return;
    step.busy(pending ? HOLD : null);
  }, [saving, pending, step]);

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
      setPicked(null);
      if (result === 'held') setNote(HELD_WORDS);
      else step.done();
    } catch (cause) {
      setNote(refusalWords(cause));
    } finally {
      setSaving(false);
    }
  };

  const keep = (): void => {
    if (mode === null) return;
    setNote(null);
    setPicked(null);
    step.busy(null);
    step.done();
  };

  return (
    <StepBody step="codex.permission" label="Codex permissions" data-codex-step="permission">
      <StepLine>When Codex wants to run a command on this machine, should it ask you first?</StepLine>
      {file !== null && mode === null ? (
        <StepLine role="alert" data-permission-unknown="">
          The current mode is unknown: this page cannot read it safely. {changeAtMachineWords(file)}
        </StepLine>
      ) : (
        <>
          <ChoiceCards
            label="Permissions"
            options={OPTIONS}
            value={file === null || shown === null ? null : shown}
            disabled={file === null || mode === null || saving}
            onChange={next => {
              if (isMode(next)) setPicked(next);
            }}
          />
          {shown === null ? null : <PermissionDemo tool="Codex" mode={shown} />}
          {pending && picked !== null && mode !== null ? (
            <StepConfirm data-permission-confirm="">
              <StepLine role="note" data-permission-words={picked}>
                {CONSEQUENCE[picked].text} Nothing is saved until you press the button.
              </StepLine>
              <StepActions>
                <Button variant="primary" disabled={saving} data-permission-use="" onClick={() => void write(picked)}>
                  {CONSEQUENCE[picked].button}
                </Button>
                <Button disabled={saving} data-permission-cancel="" onClick={keep}>
                  {KEEP[mode]}
                </Button>
              </StepActions>
            </StepConfirm>
          ) : null}
        </>
      )}
      {saving ? <StepLine role="status">Saving…</StepLine> : null}
      {note === null ? null : (
        <StepLine role="alert" data-permission-note="">
          {note}
        </StepLine>
      )}
    </StepBody>
  );
}
