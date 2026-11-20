/**
 * "Permissions" — how Claude Code handles a command it is about to run: ask first (auto mode), or never ask (Claude's
 * own `--dangerously-skip-permissions`). The page says plainly what skip allows. It writes exactly one key,
 * `permissionMode`, in `harness-claude-code.yaml` through the kernel's config route (read with its etag, written
 * against it). The file is read with the shared config reader and the one key is set with the shared one-key editor
 * (`@ferretry/std/yaml`), so every YAML form reads right and every other key and comment stays as it was. The dangerous-rm
 * waiver is a separate Settings switch and is NOT offered here. A loosening an AGENT makes stays held for the owner; this
 * is the person's own choice.
 *
 * A pick is NOT a write: moving over the cards (arrow keys included) only selects. The page then says in full what the
 * selected mode means and offers one explicit "Use …" button; only that press writes. While a pick differs from the
 * saved mode the page holds `busy`, so the shell's Next cannot record "done" over a daemon still on the old mode: the
 * person either presses "Use …" (writes, then done) or "Keep …" (done, no write), or moves back to the saved card.
 *
 * When the route does not show the file (its text is WITHHELD because it holds a secret or does not parse, or the YAML
 * does not read), the page shows the mode as unknown, writes nothing, and says where to change it at the machine.
 */
import { Button, ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PermissionModeSchema } from '../../../contract/index.ts';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { PermissionDemo } from './demos.tsx';
import type { StepPageProps } from './props.ts';
import { sentenceOf } from './words.ts';

type Mode = z.infer<typeof PermissionModeSchema>;

const FILE = 'harness-claude-code.yaml';
const READ = 'GET /v1/config/file' as const;
const WRITE = 'PUT /v1/config/file' as const;

const FileSchema = z.looseObject({
  text: z.string(),
  etag: z.string().min(1),
  absolutePath: z.string().min(1).optional(),
  state: z.string().optional(),
});
const WroteSchema = z.looseObject({ etag: z.string().min(1), outcome: z.enum(['applied', 'pending']) });

/** What each mode means, said in full before the press that writes it. */
const CONSEQUENCE: Readonly<Record<Mode, { readonly button: string; readonly text: string }>> = {
  auto: { button: 'Use Auto mode', text: 'Claude will ask you before anything risky.' },
  skip: {
    button: 'Use Skip permissions',
    text: 'Claude will run every command without asking you, including deleting files. This is Claude’s --dangerously-skip-permissions. Only choose it on a machine you would let it wipe.',
  },
};

/** The press that drops a pick and keeps what the daemon already runs. */
const KEEP: Readonly<Record<Mode, string>> = { auto: 'Keep Auto mode', skip: 'Keep Skip permissions' };

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'auto', title: 'Auto mode', line: 'Claude asks before anything risky.' },
  {
    id: 'skip',
    title: 'Skip permissions',
    line: 'Claude runs every command without asking you, including deleting files. This is Claude’s --dangerously-skip-permissions. Fastest, and only safe on a machine you would let it wipe.',
  },
];

/** Why Next is locked while a pick has not been written or dropped. */
const HOLD = 'Press “Use …” or “Keep …” to continue';

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

interface Loaded {
  readonly text: string;
  readonly etag: string;
}

export function PermissionPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const [mode, setMode] = useState<Mode | 'unknown' | null>(null);
  /** The card selected but not yet written. */
  const [picked, setPicked] = useState<Mode | null>(null);
  const [where, setWhere] = useState<string>(FILE);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<Loaded | null>(null);
  /** Whether the page has told the shell to hold Next (`null`: unknown, the next sync says it again). */
  const holding = useRef<boolean | null>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = FileSchema.parse(await client.call(READ, { query: { path: FILE } }));
      const found = permissionRead(read.text, read.state);
      setWhere(read.absolutePath ?? FILE);
      if (found.kind === 'unknown') {
        file.current = null; // never written: its text is not shown, or does not read
        setMode('unknown');
      } else {
        file.current = { text: read.text, etag: read.etag };
        setMode(found.mode);
        setPicked(prior => prior ?? found.mode);
      }
      setNote(null);
    } catch (error) {
      file.current = null;
      setNote(sentenceOf(error));
      setMode(prior => prior ?? 'unknown');
    }
    step?.ready();
  }, [client, step]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  // Hold Next while a pick differs from the saved mode; release it when the pick is written, kept or withdrawn. A save in
  // flight owns `busy` itself ("Saving…"); the sync runs again when it ends, whichever way it went (a refused save leaves
  // the pick unwritten, so the hold comes back).
  useEffect(() => {
    if (saving || mode === null) return;
    const want = mode !== 'unknown' && picked !== null && picked !== mode;
    if (holding.current === want) return;
    holding.current = want;
    step?.busy(want ? HOLD : null);
  }, [saving, mode, picked, step]);

  const keep = (): void => {
    if (mode === null || mode === 'unknown') return;
    setNote(null);
    setPicked(mode);
    holding.current = false;
    step?.busy(null);
    step?.done();
  };

  const choose = async (next: Mode): Promise<void> => {
    setNote(null);
    if (file.current === null) {
      await load();
      if (file.current === null) return;
    }
    const loaded = file.current;
    setSaving(true);
    holding.current = null;
    step?.busy('Saving…');
    try {
      const text = withPermissionMode(loaded.text, next);
      const wrote = WroteSchema.parse(await client.call(WRITE, { body: { path: FILE, text, etag: loaded.etag } }));
      file.current = { text, etag: wrote.etag };
      setMode(next);
      setPicked(next);
      if (wrote.outcome === 'pending') setNote('Saved, but the owner has to confirm it before it takes effect.');
      step?.done();
    } catch (error) {
      setNote(sentenceOf(error));
      file.current = null; // moved under us or refused: read it fresh on the next pick
    } finally {
      setSaving(false);
    }
  };

  if (mode === null) return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.permission">
      <p className="cc-step__line">When Claude Code wants to run a command on this machine, should it ask you first?</p>
      {mode === 'unknown' ? (
        <p className="cc-step__line" data-mode-unknown="">
          The current mode is unknown: this page cannot read it safely. Change this at the machine: {where}
        </p>
      ) : (
        <>
          <ChoiceCards
            label="Permissions"
            options={OPTIONS}
            value={picked ?? mode}
            onChange={next => setPicked(next as Mode)}
          />
          <PermissionDemo mode={picked ?? mode} />
          {picked !== null && picked !== mode ? (
            <div className="cc-confirm" data-permission-confirm="">
              <p className="cc-step__line" role="note" data-permission-consequence={picked}>
                {CONSEQUENCE[picked].text} Nothing is saved until you press the button.
              </p>
              <div className="cc-actions">
                <Button variant="primary" disabled={saving} onClick={() => void choose(picked)}>
                  {CONSEQUENCE[picked].button}
                </Button>
                <Button disabled={saving} onClick={keep}>
                  {KEEP[mode]}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      {saving ? (
        <p role="status" className="cc-step__line">
          Saving…
        </p>
      ) : null}
      {note === null ? null : (
        <div className="cc-actions">
          <p role="alert" className="cc-step__line">
            {note}
          </p>
          {file.current === null && mode !== 'unknown' ? <Button onClick={() => void load()}>Try again</Button> : null}
        </div>
      )}
      {note !== null && mode === 'unknown' ? (
        <div className="cc-actions">
          <Button onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
    </div>
  );
}
