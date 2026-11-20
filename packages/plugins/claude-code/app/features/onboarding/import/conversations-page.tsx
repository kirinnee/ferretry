/**
 * "Conversations": whether Ferretry may SHOW the conversations Claude Code keeps on this computer (`hostHistory`, default
 * on). It is asked in every import mode. One way: Ferretry reads them and never changes them; a conversation is copied
 * only when the person continues it here. Turning it off stops the READING and deletes nothing in `~/.claude`.
 *
 * A pick is NOT a write (ChoiceCards moves AND selects on the arrow keys): the page says what the pick means and offers one
 * explicit "Use …" press that writes; while a pick differs from what is saved it holds `busy`, so Next cannot record
 * "done" over a daemon still on the old value. It writes exactly one key. The same shape as the permission page.
 */
import { Button, ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import type { StepPageProps } from '../props.ts';
import { sentenceOf } from '../words.ts';
import { historyRead, withHostHistory } from './history-config.ts';

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

/** The owner's words (add 6): binding. */
export const ONE_WAY =
  'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.';

type Choice = 'on' | 'off';

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'on', title: 'Show them here', line: 'Your terminal’s Claude conversations appear in Ferretry.' },
  { id: 'off', title: 'Don’t show them', line: 'Ferretry will not read them. Nothing on your computer is deleted.' },
];
const USE: Readonly<Record<Choice, string>> = { on: 'Use: show them here', off: 'Use: don’t show them' };
const KEEP: Readonly<Record<Choice, string>> = { on: 'Keep showing them', off: 'Keep them hidden' };
const HOLD = 'Press “Use …” or “Keep …” to continue';

interface Loaded {
  readonly text: string;
  readonly etag: string;
}

export function ConversationsPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const [saved, setSaved] = useState<Choice | 'unknown' | null>(null);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [where, setWhere] = useState<string>(FILE);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<Loaded | null>(null);
  const holding = useRef<boolean | null>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = FileSchema.parse(await client.call(READ, { query: { path: FILE } }));
      const found = historyRead(read.text, read.state);
      setWhere(read.absolutePath ?? FILE);
      if (found.kind === 'unknown') {
        file.current = null;
        setSaved('unknown');
      } else {
        file.current = { text: read.text, etag: read.etag };
        setSaved(found.kind);
        setPicked(prior => prior ?? found.kind);
      }
      setNote(null);
    } catch (error) {
      file.current = null;
      setNote(sentenceOf(error));
      setSaved(prior => prior ?? 'unknown');
    }
    step?.ready();
  }, [client, step]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    if (saving || saved === null) return;
    const want = saved !== 'unknown' && picked !== null && picked !== saved;
    if (holding.current === want) return;
    holding.current = want;
    step?.busy(want ? HOLD : null);
  }, [saving, saved, picked, step]);

  const keep = (): void => {
    if (saved === null || saved === 'unknown') return;
    setNote(null);
    setPicked(saved);
    holding.current = false;
    step?.busy(null);
    step?.done();
  };

  const choose = async (next: Choice): Promise<void> => {
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
      const text = withHostHistory(loaded.text, next === 'on');
      const wrote = WroteSchema.parse(await client.call(WRITE, { body: { path: FILE, text, etag: loaded.etag } }));
      file.current = { text, etag: wrote.etag };
      setSaved(next);
      setPicked(next);
      if (wrote.outcome === 'pending') setNote('Saved, but the owner has to confirm it before it takes effect.');
      step?.done();
    } catch (error) {
      setNote(sentenceOf(error));
      file.current = null;
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.conversations">
      <p className="cc-step__line">Show the conversations you already have in your terminal’s Claude Code?</p>
      <p className="cc-step__line" data-conversations-one-way="">
        {ONE_WAY}
      </p>
      {saved === 'unknown' ? (
        <p className="cc-step__line" data-mode-unknown="">
          The current setting is unknown: this page cannot read it safely. Change it at the machine: {where}
        </p>
      ) : (
        <>
          <ChoiceCards
            label="Conversations"
            options={OPTIONS}
            value={picked ?? saved}
            onChange={next => setPicked(next as Choice)}
          />
          {picked !== null && picked !== saved ? (
            <div className="cc-confirm" data-conversations-confirm="">
              <p className="cc-step__line" role="note">
                Nothing is saved until you press the button.
              </p>
              <div className="cc-actions">
                <Button variant="primary" disabled={saving} onClick={() => void choose(picked)}>
                  {USE[picked]}
                </Button>
                <Button disabled={saving} onClick={keep}>
                  {KEEP[saved]}
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
          {file.current === null ? <Button onClick={() => void load()}>Try again</Button> : null}
        </div>
      )}
    </div>
  );
}
