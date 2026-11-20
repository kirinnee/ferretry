/**
 * Step `permission`: Auto mode or Skip permissions (r11 O5). Two stacked cards on the left, the demo on the right
 * (`StepDemo`), nothing to press on the page: the footer's Next saves the pick.
 *
 * The card selected on opening is the config value (default `skip`, owner !A525). A pick is NOT a write: moving over the
 * cards (arrow keys included) only selects. When the pick differs from the saved mode the page registers `host.commit`
 * (contract rule 8); only a real Next press runs it, under the shell's "Saving…": it changes ONLY `permissionMode` in
 * `config/harness-codex.yaml`, through the config route and the shared one-key editor, so every other key and comment
 * stays. When the pick equals the saved mode the commit is cleared and Next writes nothing. A refusal, or a change the
 * daemon HOLDS for the owner's confirmation, rejects the commit: the footer says why, the page stays, Next can try again.
 * A file the page cannot read safely (withheld by the daemon, or not valid YAML) shows the mode as unknown and writes
 * nothing: "Change this at the machine: <file>". While Skip is selected ONE line names the real flag and says in plain
 * words what it allows. The dangerous-rm waiver is a separate Settings switch and is not offered here.
 */
import { ChoiceCards, type ChoiceOption, StepDemo } from '@ferretry/app';
import { PermissionDemo, StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import type { StepHost } from './onboarding-api.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTO_WORDS,
  type ConfigFile,
  type OnboardingClient,
  type PermissionMode,
  SKIP_FLAG,
  SKIP_PLAIN,
  SKIP_WORDS,
  changeAtMachineWords,
  currentMode,
  readConfig,
  refusalWords,
  writeMode,
} from './onboarding-api.ts';

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'auto', title: 'Auto mode', line: AUTO_WORDS },
  { id: 'skip', title: 'Skip permissions', line: SKIP_WORDS },
];

const HELD_WORDS = 'That change is waiting for your confirmation in Settings › Codex.';

const isMode = (value: string): value is PermissionMode => value === 'auto' || value === 'skip';

export function PermissionPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  /** The mode the file says now; `null` is unknown (withheld or unparsable) and nothing is written then. */
  const [mode, setMode] = useState<PermissionMode | null>('skip');
  /** The card selected but not yet written. */
  const [picked, setPicked] = useState<PermissionMode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** True from the moment Next starts the write until the daemon answers: the pick the footer captured is the one saved. */
  const [saving, setSaving] = useState(false);
  // What a commit reads is the file as it is NOW, never a stale copy from the render that registered it.
  const latest = useRef<ConfigFile | null>(null);
  latest.current = file;

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

  const save = useCallback(
    (chosen: PermissionMode) => async (): Promise<void> => {
      const now = latest.current;
      if (now === null) throw new Error('The permission file has not been read yet.');
      setSaving(true);
      try {
        const result = await writeMode(client, now, chosen).catch((cause: unknown) => {
          throw new Error(refusalWords(cause));
        });
        const fresh = await readConfig(client);
        setFile(fresh);
        // A change the daemon holds for the owner is not saved: say so, stay, and let Next try again.
        if (result === 'held') throw new Error(HELD_WORDS);
        setMode(currentMode(fresh) ?? chosen);
        setPicked(null);
      } finally {
        setSaving(false);
      }
    },
    [client],
  );

  const choose = (next: string): void => {
    if (!isMode(next) || mode === null) return;
    setNote(null);
    if (next === mode) {
      setPicked(null);
      step.commit(null);
    } else {
      setPicked(next);
      step.commit(save(next));
    }
  };

  const shown: PermissionMode | null = picked ?? mode;
  return (
    <StepBody step="codex.permission" label="Codex permissions" data-codex-step="permission">
      {file !== null && mode === null ? (
        <StepLine role="alert" data-permission-unknown="">
          The current mode is unknown: this page cannot read it safely. {changeAtMachineWords(file)}
        </StepLine>
      ) : (
        <>
          <ChoiceCards
            label="Permissions"
            layout="stack"
            options={OPTIONS}
            value={file === null || shown === null ? null : shown}
            disabled={file === null || mode === null || saving}
            onChange={choose}
          />
          {shown === 'skip' ? (
            <StepLine role="note" data-permission-words="skip">
              {SKIP_PLAIN} Codex’s <code>{SKIP_FLAG}</code>.
            </StepLine>
          ) : null}
          {shown === null ? null : (
            <StepDemo>
              <PermissionDemo tool="Codex" mode={shown} />
            </StepDemo>
          )}
        </>
      )}
      {note === null ? null : (
        <StepLine role="alert" data-permission-note="">
          {note}
        </StepLine>
      )}
    </StepBody>
  );
}
