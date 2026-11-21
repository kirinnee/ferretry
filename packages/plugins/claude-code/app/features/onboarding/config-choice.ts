/**
 * A first-run page that asks ONE question whose answer is ONE key in `harness-claude-code.yaml` (the permission mode, whether
 * the conversations show): the file is read with its etag, the page offers the pick, and Next SAVES it (`step.commit`,
 * contract rule 8) — the page draws no Save/Use/Keep button of its own. A pick is not a write: choosing a card (the arrow
 * keys too) only selects; only a real Next writes, once, against the etag it read, and `Later` and Back never do. A pick
 * equal to what is saved registers nothing, so Next just records the answer.
 *
 * A refused write throws: the footer shows the reason, the page stays, and the next Next reads the file afresh and tries
 * again. A write the machine HELD for the owner is saved but not yet in effect: the footer says so once and the next Next
 * goes on (the saved mode is then the pick, so nothing is written again). When the route does not show the file (its text
 * is WITHHELD, or the YAML does not read), the page shows the answer as unknown and writes nothing. The same when the file
 * has a change HELD for the owner (the read says `pending`): the text on disk is not what is in effect, and a one-key save
 * would carry the held edit with it, so the page writes nothing and says to confirm or discard that change first.
 */
import type { StepHost } from '@ferretry/kernel/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { sentenceOf } from './words.ts';

const CONFIG_FILE = 'harness-claude-code.yaml';
const READ = 'GET /v1/config/file' as const;
const WRITE = 'PUT /v1/config/file' as const;

const FileSchema = z.looseObject({
  text: z.string(),
  etag: z.string().min(1),
  absolutePath: z.string().min(1).optional(),
  state: z.string().optional(),
});
const WroteSchema = z.looseObject({ etag: z.string().min(1), outcome: z.enum(['applied', 'pending']) });

/** Shown (by the page) in place of the cards while the file carries a change held for the owner. */
export const WAITING = 'A change to this file is waiting for your OK. Confirm or discard it in Settings › Files first.';

const SETTLED = 'That change is settled. Choose below, then press Next.';

const HELD = 'Saved, but the owner has to confirm it before it takes effect. Press Next to go on.';

interface Loaded {
  readonly text: string;
  readonly etag: string;
}

export interface ConfigChoiceOptions<T extends string> {
  readonly client: ClaudeCodeClient;
  readonly step?: StepHost | undefined;
  /** The answer the file holds, or `null` when it cannot be told safely (withheld, unreadable, a value that is not one). */
  readonly read: (text: string, state?: string) => T | null;
  /** The file's text with the answer set and every other key and comment left as it was. */
  readonly write: (text: string, value: T) => string;
}

export interface ConfigChoice<T extends string> {
  /** `null` until the first read ends; `'unknown'` when the answer cannot be told. */
  readonly saved: T | 'unknown' | null;
  /** The card showing: the pick, else the saved answer. */
  readonly shown: T | null;
  readonly pick: (next: T) => void;
  /** Where to change it at the machine, for the unknown case. */
  readonly where: string;
  /** Why the file could not be read, when it could not. */
  readonly note: string | null;
  /** The file carries a change held for the owner: nothing is shown to pick and nothing is written ({@link WAITING}). */
  readonly waiting: boolean;
  readonly retry: () => void;
}

export function useConfigChoice<T extends string>({
  client,
  step,
  read,
  write,
}: ConfigChoiceOptions<T>): ConfigChoice<T> {
  const [saved, setSaved] = useState<T | 'unknown' | null>(null);
  const [picked, setPicked] = useState<T | null>(null);
  const [where, setWhere] = useState<string>(CONFIG_FILE);
  const [note, setNote] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const file = useRef<Loaded | null>(null);
  /** A save is registered with the shell (and so must be withdrawn when the file stops being readable). */
  const registered = useRef(false);

  /** Reads the file; the sentence of why it cannot be saved to (unreadable, or held), or `null`. */
  const load = useCallback(async (): Promise<string | null> => {
    let failure: string | null = null;
    try {
      const got = FileSchema.parse(await client.call(READ, { query: { path: CONFIG_FILE } }));
      const held = got.state === 'pending';
      const found = held ? null : read(got.text, got.state);
      setWhere(got.absolutePath ?? CONFIG_FILE);
      setWaiting(held);
      if (held) failure = WAITING; // said by the footer when Next reaches a held file; the page itself shows it in the cards' place
      if (found === null) {
        file.current = null; // never written: its text is not shown, or does not read
        setSaved('unknown');
        setPicked(null); // the pick was made against a file that can no longer be read: it is hidden, so it is dropped
      } else {
        file.current = { text: got.text, etag: got.etag };
        setSaved(found);
        setPicked(prior => prior ?? found);
      }
      setNote(null);
    } catch (error) {
      file.current = null;
      failure = sentenceOf(error);
      setNote(failure);
      setSaved(prior => prior ?? 'unknown');
    }
    step?.ready();
    return failure;
  }, [client, read, step]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  // What Next saves follows the pick: nothing when it is the saved answer.
  useEffect(() => {
    if (step === undefined || saved === null) return;
    if (waiting) {
      // The file carries a held change, so nothing can be picked or written. But the owner may confirm or discard it
      // while this page stays up: Next reads the file again instead of just going on. Still held: the footer says so
      // and the page stays. Settled: the page now draws the cards, and the owner picks (or keeps) the mode and presses Next.
      registered.current = true;
      step.commit(async () => {
        const failure = await load();
        if (failure !== null) throw new Error(failure);
        throw new Error(SETTLED);
      });
      return;
    }
    if (saved === 'unknown' || picked === null) {
      // Nothing is shown to save: a hidden pick never writes, now or once the file reads again.
      if (registered.current) step.commit(null);
      registered.current = false;
      return;
    }
    if (picked === saved) {
      step.commit(null);
      return;
    }
    registered.current = true;
    step.commit(async () => {
      const failure = file.current === null ? await load() : null;
      const loaded = file.current as Loaded | null;
      if (loaded === null) throw new Error(failure ?? 'The file could not be read.');
      try {
        const text = write(loaded.text, picked);
        const wrote = WroteSchema.parse(
          await client.call(WRITE, { body: { path: CONFIG_FILE, text, etag: loaded.etag } }),
        );
        file.current = { text, etag: wrote.etag };
        setSaved(picked);
        if (wrote.outcome === 'pending') throw new Error(HELD);
      } catch (error) {
        // Moved under us or refused: read it afresh on the next Next. (A held write is saved: the file is current.)
        if (!(error instanceof Error && error.message === HELD)) file.current = null;
        throw error instanceof Error ? error : new Error(sentenceOf(error));
      }
    });
  }, [saved, picked, waiting, step, client, load, write]);

  const pick = useCallback((next: T) => setPicked(next), []);
  const retry = useCallback(() => void load(), [load]);
  return { saved, shown: picked ?? (saved === 'unknown' ? null : saved), pick, where, note, waiting, retry };
}
