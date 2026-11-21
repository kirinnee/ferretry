/**
 * "Permissions" — how Claude Code handles a command it is about to run: ask first (auto mode), or never ask (Claude's
 * own `--dangerously-skip-permissions`). Two stacked cards, the demo on the right, and ONE line under the cards whenever
 * Skip is shown, naming the real flag and what it allows. It writes exactly one key, `permissionMode`, in
 * `harness-claude-code.yaml` through the kernel's config route (read with its etag, written against it), and only when the
 * person presses Next (`useConfigChoice`: the page registers the save, contract rule 8, and draws no button of its own).
 * The file is read with the shared config reader and the one key is set with the shared one-key editor
 * (`@ferretry/std/yaml`), so every YAML form reads right and every other key and comment stays as it was. The dangerous-rm
 * waiver is a separate Settings switch and is NOT offered here. A loosening an AGENT makes stays held for the owner; this
 * is the person's own choice.
 *
 * A pick is NOT a write: moving over the cards (arrow keys included) only selects.
 *
 * When the route does not show the file (its text is WITHHELD because it holds a secret or does not parse, or the YAML
 * does not read), the page shows the mode as unknown, writes nothing, and says where to change it at the machine.
 */
import { Button, ChoiceCards, type ChoiceOption, StepDemo } from '@ferretry/app';
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import type { z } from 'zod';
import { PermissionModeSchema } from '../../../contract/index.ts';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { useConfigChoice, WAITING } from './config-choice.ts';
import { PermissionDemo } from './demos.tsx';
import type { StepPageProps } from './props.ts';

type Mode = z.infer<typeof PermissionModeSchema>;

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'auto', title: 'Auto mode', line: 'Asks before anything risky.' },
  { id: 'skip', title: 'Skip permissions', line: 'Never asks.' },
];

/** What Skip allows, in plain words with the real flag: one line, shown whenever Skip is the card showing. */
const SKIP_WARNING =
  '--dangerously-skip-permissions runs every command, even deleting files. Only on a machine you would let it wipe.';

/** The comment the route answers in place of a text it will not show (kernel `withheldComment`). */
const WITHHELD = /^# ‹hidden›: the text of this file is not shown because/u;

/** What the file says now: a mode, or why none can be told (the default is `skip`, owner !A525). */
export type PermissionRead = { readonly kind: 'mode'; readonly mode: Mode } | { readonly kind: 'unknown' };

export const permissionRead = (text: string, state?: string): PermissionRead => {
  if (WITHHELD.test(text) || state === 'invalid') return { kind: 'unknown' };
  const read = readConfigText(text);
  if (!read.ok) return { kind: 'unknown' };
  const value = read.read.value;
  if (value === null || value === undefined) return { kind: 'mode', mode: 'skip' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
  const { permissionMode: raw } = value as { readonly permissionMode?: unknown };
  if (raw === undefined || raw === null) return { kind: 'mode', mode: 'skip' };
  const parsed = PermissionModeSchema.safeParse(raw);
  return parsed.success ? { kind: 'mode', mode: parsed.data } : { kind: 'unknown' };
};

/** The file with `permissionMode` set and every other key and comment left exactly as it was. */
export const withPermissionMode = (text: string, mode: Mode): string => {
  const read = readConfigText(text);
  if (!read.ok || permissionRead(text).kind === 'unknown') throw new Error('the file cannot be edited here');
  const value = read.read.value;
  const now = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  // The shared editor sets a scalar in place, so a comment on its line stays; every other key and comment is kept.
  return editConfigText(text, { ...now, permissionMode: mode }, now, undefined);
};

const modeOf = (text: string, state?: string): Mode | null => {
  const found = permissionRead(text, state);
  return found.kind === 'mode' ? found.mode : null;
};

export function PermissionPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const { saved, shown, pick, where, note, waiting, retry } = useConfigChoice<Mode>({
    client,
    step,
    read: modeOf,
    write: withPermissionMode,
  });

  if (saved === null) return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.permission">
      {waiting ? (
        <p className="cc-step__line" data-config-waiting="">
          {WAITING}
        </p>
      ) : saved === 'unknown' ? (
        <p className="cc-step__line" data-mode-unknown="">
          The current mode is unknown: this page cannot read it safely. Change this at the machine: {where}
        </p>
      ) : (
        <>
          <ChoiceCards
            label="Permissions"
            layout="stack"
            options={OPTIONS}
            value={shown ?? saved}
            onChange={next => pick(next as Mode)}
          />
          <StepDemo>
            <PermissionDemo mode={shown ?? saved} />
          </StepDemo>
          {(shown ?? saved) === 'skip' ? (
            <p className="cc-step__line cc-step__warn" role="note" data-permission-consequence="skip">
              {SKIP_WARNING}
            </p>
          ) : null}
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
