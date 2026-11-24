/**
 * "PERMISSIONS": ONE page for every harness the person picked. A single tick-box, "Use Ferretry's autonomous defaults
 * (recommended)", is ticked by default and means every picked harness never asks before it runs a command. Under "Change" the
 * per-harness choice (Auto mode / Skip permissions) is offered for those who want one harness to ask; choosing Auto anywhere
 * unticks the box. A pick is NOT a write: only the footer's Next writes (`step.commit`, contract rule 8), once per file that
 * changed, against the etag it read; `Later` and Back never write. A file the page cannot read safely (its text is withheld, it
 * does not parse, or a change to it waits for the owner) shows its harness as unknown, writes nothing and says where to change it.
 * The dangerous-rm waiver is a separate Settings switch and is NOT offered here.
 */
import { ChoiceCards, type ChoiceOption, StepDemo } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { PermissionDemo } from '@ferretry/plugin-runtimes/import-kit';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { type Mode, type PermissionHarness, allSetTo, isAutonomous, modeOf, withMode } from './permissions-model.ts';

/** The route pair that reads and writes a config file (the kernel's: no plugin owns it). */
export interface PermissionsFiles {
  readonly read: (file: string) => Promise<ReadFile>;
  /** Writes the whole text against the etag it was read at; `held` when the owner has to confirm it before it takes effect. */
  readonly write: (file: string, text: string, etag: string) => Promise<'applied' | 'held'>;
}

export interface ReadFile {
  readonly text: string;
  readonly etag: string;
  /** Where the file is on the machine, for "Change this at the machine: <file>". */
  readonly where: string;
  /** The daemon did not show the text (it looks like a credential, or does not parse): it must not be written. */
  readonly withheld: boolean;
  /** An earlier change to the file waits for the owner: a write from here would overwrite it. */
  readonly pending: boolean;
}

const OPTIONS: readonly ChoiceOption[] = [
  { id: 'auto', title: 'Auto mode', line: 'Asks before risky things.' },
  { id: 'skip', title: 'Skip permissions', line: 'Never asks.' },
];

const HELD = 'Saved, but the owner has to confirm it before it takes effect. Press Next to go on.';
const WAITING = 'A change to this file is waiting for your OK. Confirm or discard it in Settings › Files first.';

/** What a harness's file said when the page read it: its mode, or why none can be told. */
type Saved =
  | { readonly kind: 'mode'; readonly mode: Mode; readonly file: ReadFile }
  | { readonly kind: 'unknown'; readonly where: string }
  | { readonly kind: 'failed'; readonly words: string };

const sentenceOf = (cause: unknown): string => {
  const said = cause instanceof Error ? cause.message.trim() : '';
  return said === '' ? 'This machine did not answer.' : said;
};

const savedOf = (file: ReadFile): Saved => {
  const mode = file.withheld || file.pending ? null : modeOf(file.text);
  return mode === null ? { kind: 'unknown', where: file.where } : { kind: 'mode', mode, file };
};

export function PermissionsPage({
  step,
  harnesses,
  files,
}: {
  readonly step: StepHost | undefined;
  /** The harnesses the person picked that have a permission mode (`coveredBy`). */
  readonly harnesses: readonly PermissionHarness[];
  readonly files: PermissionsFiles;
}): ReactNode {
  const [saved, setSaved] = useState<Readonly<Record<string, Saved>> | null>(null);
  const [picked, setPicked] = useState<Readonly<Record<string, Mode>>>({});
  const [open, setOpen] = useState(false);
  const host = useRef(step);
  host.current = step;

  const load = useCallback(async (): Promise<Readonly<Record<string, Saved>>> => {
    const entries = await Promise.all(
      harnesses.map(async harness => {
        try {
          return [harness.key, savedOf(await files.read(harness.file))] as const;
        } catch (cause) {
          return [harness.key, { kind: 'failed', words: sentenceOf(cause) } as Saved] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }, [harnesses, files]);

  useEffect(() => {
    let current = true;
    void load().then(read => {
      if (!current) return;
      setSaved(read);
      // The box is ticked when the files agree with the defaults; a harness already on Auto opens "Change" so it is seen.
      setOpen(Object.values(read).some(entry => entry.kind === 'mode' && entry.mode === 'auto'));
      host.current?.ready();
    });
    return () => {
      current = false;
    };
  }, [load]);

  const modeOfHarness = (key: string): Mode | null => {
    const entry = saved?.[key];
    return entry?.kind === 'mode' ? (picked[key] ?? entry.mode) : null;
  };
  const shown: Record<string, Mode> = {};
  for (const harness of harnesses) {
    const mode = modeOfHarness(harness.key);
    if (mode !== null) shown[harness.key] = mode;
  }
  const writable = Object.keys(shown);
  const autonomous = isAutonomous(shown);

  const pick = (key: string, mode: Mode): void => {
    setPicked(before => ({ ...before, [key]: mode }));
  };
  const tick = (on: boolean): void => {
    setPicked(allSetTo(writable, on ? 'skip' : 'auto'));
    if (!on) setOpen(true);
  };

  // What Next saves follows the pick: nothing when every file already says what is shown.
  useEffect(() => {
    if (saved === null || host.current === undefined) return;
    const changed = harnesses.filter(harness => {
      const entry = saved[harness.key];
      return entry?.kind === 'mode' && picked[harness.key] !== undefined && picked[harness.key] !== entry.mode;
    });
    if (changed.length === 0) {
      host.current.commit(null);
      return;
    }
    host.current.commit(async () => {
      let held = false;
      for (const harness of changed) {
        const fresh = savedOf(
          await files.read(harness.file).catch((cause: unknown) => {
            throw new Error(sentenceOf(cause));
          }),
        );
        if (fresh.kind !== 'mode') throw new Error(fresh.kind === 'unknown' ? WAITING : fresh.words);
        const mode = picked[harness.key] as Mode;
        const outcome = await files
          .write(harness.file, withMode(fresh.file.text, mode), fresh.file.etag)
          .catch((cause: unknown) => {
            throw new Error(sentenceOf(cause));
          });
        held ||= outcome === 'held';
      }
      setSaved(await load());
      setPicked({});
      if (held) throw new Error(HELD);
    });
  }, [harnesses, picked, saved, files, load]);

  const detailsId = useId();
  if (saved === null)
    return (
      <p className="m-0 text-cell text-muted" role="status" data-permissions-reading="">
        Looking at how your AI tools handle permissions…
      </p>
    );
  const first = harnesses.find(harness => shown[harness.key] !== undefined);
  const skipping = harnesses.filter(harness => shown[harness.key] === 'skip');
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step="onboarding.permissions">
      <label
        className="kt-panel flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 p-panel hover:border-accent has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus"
        data-permissions-defaults=""
      >
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
          checked={autonomous}
          disabled={writable.length === 0}
          onChange={event => tick(event.currentTarget.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-row font-semibold text-fg">Use Ferretry’s autonomous defaults (recommended)</span>
          <span className="text-cell text-muted">
            {harnesses.map(harness => harness.label).join(' and ')} run commands without stopping to ask.
          </span>
        </span>
      </label>
      {skipping.length === 0 ? null : (
        <div
          className="flex min-w-0 flex-col gap-1 text-cell text-muted"
          role="note"
          data-permission-consequence="skip"
        >
          <p className="m-0">
            Runs every command without asking, even deleting files. Only on a machine you would let it wipe.
          </p>
          {skipping.map(harness => (
            <p key={harness.key} className="m-0">
              {harness.label}: <code className="[overflow-wrap:anywhere]">{harness.flag}</code>
            </p>
          ))}
        </div>
      )}
      <button
        type="button"
        className="inline-flex min-h-[44px] items-center self-start text-cell underline"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        data-permissions-change=""
      >
        Change
      </button>
      {open ? (
        <div id={detailsId} className="flex min-w-0 flex-col gap-3" data-permissions-details="">
          {harnesses.map(harness => {
            const entry = saved[harness.key];
            return (
              <section key={harness.key} className="flex min-w-0 flex-col gap-2" data-permissions-harness={harness.key}>
                <h3 className="m-0 text-cell font-semibold text-fg">{harness.label}</h3>
                {entry?.kind === 'mode' ? (
                  <ChoiceCards
                    label={`${harness.label} permissions`}
                    layout="stack"
                    options={OPTIONS}
                    value={shown[harness.key] ?? entry.mode}
                    onChange={next => pick(harness.key, next as Mode)}
                  />
                ) : (
                  <p className="m-0 text-cell text-warn" role="alert" data-permissions-unknown={harness.key}>
                    {entry?.kind === 'failed'
                      ? entry.words
                      : `The current mode is unknown: this page cannot read it safely. Change this at the machine: ${
                          entry?.kind === 'unknown' ? entry.where : harness.file
                        }`}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      ) : null}
      {first === undefined ? null : (
        <StepDemo>
          <PermissionDemo tool={first.label} mode={shown[first.key] ?? 'skip'} />
        </StepDemo>
      )}
    </div>
  );
}
