/**
 * "Permissions" — how Claude Code handles a command it is about to run: ask first (auto mode), or never ask (Claude's
 * own `--dangerously-skip-permissions`). The page says plainly what skip allows. It writes exactly one key,
 * `permissionMode`, in `harness-claude-code.yaml` through the kernel's config route (read with its etag, written
 * against it). The dangerous-rm waiver is a separate Settings switch and is NOT offered here. A loosening an AGENT
 * makes stays held for the owner; this is the person's own choice.
 */
import { Button } from '@ferretry/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PermissionModeSchema } from '../../../contract/index.ts';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { PermissionDemo } from './demos.tsx';
import { ChoiceCards, type ChoiceOption, type StepPageProps } from './kit.tsx';
import { sentenceOf } from './words.ts';

type Mode = z.infer<typeof PermissionModeSchema>;

const FILE = 'harness-claude-code.yaml';
const READ = 'GET /v1/config/file' as const;
const WRITE = 'PUT /v1/config/file' as const;

const FileSchema = z.looseObject({ text: z.string(), etag: z.string().min(1) });
const WroteSchema = z.looseObject({ etag: z.string().min(1), outcome: z.enum(['applied', 'pending']) });

const OPTIONS: readonly ChoiceOption<Mode>[] = [
  { id: 'auto', title: 'Auto mode', line: 'Claude asks before anything risky.' },
  {
    id: 'skip',
    title: 'Skip permissions',
    line: 'Claude runs every command without asking you, including deleting files. This is Claude’s --dangerously-skip-permissions. Fastest, and only safe on a machine you would let it wipe.',
  },
];

const MODE_LINE = /^permissionMode:[ \t]*['"]?([a-z]+)['"]?[ \t]*(?:#.*)?$/mu;

/** What the file says now; `skip` (the default, owner !A525) when it says nothing or something unreadable. */
export const permissionModeOf = (text: string): Mode => {
  const parsed = PermissionModeSchema.safeParse(MODE_LINE.exec(text)?.[1]);
  return parsed.success ? parsed.data : 'skip';
};

/** The file with `permissionMode` set and every other line left exactly as it was. */
export const withPermissionMode = (text: string, mode: Mode): string => {
  if (MODE_LINE.test(text)) return text.replace(MODE_LINE, `permissionMode: ${mode}`);
  const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${body}permissionMode: ${mode}\n`;
};

export function PermissionPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<{ text: string; etag: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = FileSchema.parse(await client.call(READ, { query: { path: FILE } }));
      file.current = { text: read.text, etag: read.etag };
      setMode(permissionModeOf(read.text));
      setNote(null);
    } catch (error) {
      setNote(sentenceOf(error));
      setMode(prior => prior ?? 'skip');
    }
    step?.ready();
  }, [client, step]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const choose = async (next: Mode): Promise<void> => {
    setMode(next);
    setNote(null);
    if (file.current === null) {
      await load();
      if (file.current === null) return;
    }
    setSaving(true);
    step?.busy('Saving…');
    try {
      const wrote = WroteSchema.parse(
        await client.call(WRITE, {
          body: { path: FILE, text: withPermissionMode(file.current.text, next), etag: file.current.etag },
        }),
      );
      file.current = { text: withPermissionMode(file.current.text, next), etag: wrote.etag };
      if (wrote.outcome === 'pending') setNote('Saved, but the owner has to confirm it before it takes effect.');
      step?.done();
    } catch (error) {
      setNote(sentenceOf(error));
      file.current = null; // moved under us or refused: read it fresh on the next pick
    } finally {
      setSaving(false);
      step?.busy(null);
    }
  };

  if (mode === null) return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.permission">
      <p className="cc-step__line">When Claude Code wants to run a command on this machine, should it ask you first?</p>
      <ChoiceCards
        legend="Permissions"
        name="permission-mode"
        options={OPTIONS}
        value={mode}
        onChange={next => void choose(next)}
      />
      <PermissionDemo mode={mode} />
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
          {file.current === null ? <Button onClick={() => void load()}>Try again</Button> : null}
        </div>
      )}
    </div>
  );
}
