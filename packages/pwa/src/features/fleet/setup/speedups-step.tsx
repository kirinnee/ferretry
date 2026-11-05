/**
 * New machine setup's **Speed-ups** step: ONE `Save keys` primary in the pinned footer. It saves every key
 * that was typed through the ordinary secret route (write-only, never shown back), runs the existing test
 * on each, and moves on when they worked. Jev is the one on show; Groq and Cerebras (dictation clean-up)
 * are folded under their own heading. Settings › Speed-ups (`speedups-surface.tsx`) is where a key is
 * replaced, tested again, or looked at later.
 *
 * Under the Jev key sits "Let the Warden use Jev", ticked: when a Jev key is saved and works, `Save keys`
 * also switches Jev on through the Warden's own PATCH (`wardenStartingDraft`). With no Jev key saved the
 * Warden is never touched, so Jev stays off.
 */

import { type SpeedupStatus, type SpeedupsView, WardenConfigViewSchema } from '@ferretry/protocol';
import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putSecret } from '../../secrets/secrets-api.ts';
import { readSpeedups, testSpeedup } from '../../speedups/speedups-api.ts';
import { keyDraftProblem } from '../../speedups/speedups-surface.tsx';
import { wardenConfigPatchFrom } from '../../warden/warden-settings-model.ts';
import type { FleetClient } from '../fleet-client.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { PrimaryAction } from './footer-slot.tsx';
import { wardenStartingDraft } from './onboarding-model.ts';
import { SetupNote } from './setup-ui.tsx';
import { listWords } from './setup-words.ts';

/**
 * Switch the Warden's Jev layer on through its own PATCH, only while the machine is still on the free
 * default (`wardenStartingDraft`): a layer the owner chose, or a Warden they turned off, is left alone.
 * `null` when it worked or there was nothing to change; a sentence when it did not.
 */
const switchJevOn = async (client: FleetClient): Promise<string | null> => {
  try {
    const view = await client.request('/v1/warden/config', WardenConfigViewSchema);
    const patch = wardenConfigPatchFrom(view.config, wardenStartingDraft(view.config, true));
    if (Object.keys(patch).length === 0) return null;
    await client.request('/v1/warden/config', WardenConfigViewSchema, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return null;
  } catch (cause) {
    return `Your keys are saved, but Jev could not be switched on for the Warden. ${changeRefusalSentence(cause)} Skip, then turn it on in Settings › Warden.`;
  }
};

/** The keys that were typed, by provider; a field left empty is not one. */
const typedKeys = (drafts: Readonly<Record<string, string>>): readonly [string, string][] =>
  Object.entries(drafts)
    .map(([provider, value]): [string, string] => [provider, value.trim()])
    .filter(([, value]) => value.length > 0);

function KeyField({
  status,
  value,
  disabled,
  onChange,
}: {
  readonly status: SpeedupStatus;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const id = `speedup-key-${status.provider}`;
  const problem = keyDraftProblem(value);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-speedup-field={status.provider}>
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-cell font-semibold text-fg">
        {status.label} key
        {status.set ? (
          <span className="text-meta font-normal text-ok" data-speedup-set="">
            set ✓ · type a new one to replace it
          </span>
        ) : null}
      </label>
      <p className="m-0 text-meta leading-base text-muted">{status.purpose}</p>
      <p className="m-0 text-meta leading-base text-muted" data-speedup-cost="">
        {status.costNote}
      </p>
      <p className="m-0 text-meta leading-base text-muted" data-speedup-privacy="">
        {status.privacyNote}
      </p>
      <input
        id={id}
        // `password` so it is not read over a shoulder; `new-password` so no password manager keeps a
        // copy of a credential this browser only relays.
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        className="kt-input w-full min-w-0 font-mono"
        value={value}
        disabled={disabled}
        placeholder="Paste your key — it is never shown again"
        aria-invalid={problem !== undefined}
        onChange={event => onChange(event.target.value)}
      />
      {problem === undefined ? null : <span className="text-meta text-err">{problem}</span>}
      <a
        href={status.keyUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex min-w-0 items-center gap-1 self-start text-meta text-accent underline"
      >
        Get a {status.label} key
        <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
      </a>
    </div>
  );
}

export function OnboardingSpeedupsStep({
  tab,
  onSaved,
  onFinished,
}: {
  readonly tab: MachineTabProps;
  /** At least one key is stored: the step is set. */
  readonly onSaved: () => void;
  /** Every typed key was stored and worked: the page moves on. */
  readonly onFinished: (stillHere: boolean) => void;
}) {
  const { connection, createClient, machineName } = tab;
  const [view, setView] = useState<SpeedupsView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<'saving' | 'testing' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dictationOpen, setDictationOpen] = useState(false);
  const [warden, setWarden] = useState(true);
  const latest = useRef({ onSaved, onFinished });
  latest.current = { onSaved, onFinished };
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(readSpeedups)
      .then(
        next => {
          if (live) setView(next);
        },
        (cause: unknown) => {
          if (live) setFailure(changeRefusalSentence(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const typed = typedKeys(drafts);
  const idle = busy === null;
  // Save keys saves every key that was typed, so it waits until every one of them is a whole key: a short
  // second key is never dropped quietly.
  const unfinished = (view?.providers ?? []).filter(
    status =>
      typed.some(([provider]) => provider === status.provider) &&
      keyDraftProblem(drafts[status.provider] ?? '') !== undefined,
  );

  const save = useCallback(async (): Promise<void> => {
    setProblem(null);
    setBusy('saving');
    try {
      const client = await createClient(connection);
      for (const [provider, value] of typed) {
        const status = view?.providers.find(candidate => candidate.provider === provider);
        if (status !== undefined) await putSecret(client, status.secretName, value);
      }
      setDrafts({});
      setBusy('testing');
      const failed: string[] = [];
      for (const [provider] of typed) {
        const status = view?.providers.find(candidate => candidate.provider === provider);
        const result = await testSpeedup(client, provider as SpeedupStatus['provider']).catch((cause: unknown) => ({
          ok: false,
          message: changeRefusalSentence(cause),
        }));
        if (!result.ok) failed.push(`${status?.label ?? provider}: ${result.message}`);
      }
      const jevWorked = typed.some(([provider]) => provider === 'jev') && !failed.some(line => line.startsWith('Jev'));
      const wardenProblem = warden && jevWorked ? await switchJevOn(client) : null;
      setView(await readSpeedups(client));
      if (failed.length === 0) {
        // Only keys that worked set the step: a saved key that failed its test leaves it open.
        latest.current.onSaved();
        if (wardenProblem === null) latest.current.onFinished(here.current);
        else setProblem(wardenProblem);
      } else setProblem(`Saved, but the test didn’t pass. ${failed.join(' ')} Paste a corrected key, or skip.`);
    } catch (cause) {
      setProblem(changeRefusalSentence(cause));
    } finally {
      setBusy(null);
    }
  }, [connection, createClient, typed, view, warden]);

  /**
   * Keys already stored and every one of them proven (its last test passed, on this very key), none being
   * typed and no failed test to answer: the page's forward action is Continue, as on a CLI already imported.
   * A stored key whose test failed or is stale keeps the page on Save keys, so a key that did not work is
   * never walked past.
   */
  const stored = (view?.providers ?? []).filter(status => status.set);
  const revisit =
    typed.length === 0 &&
    problem === null &&
    stored.length > 0 &&
    stored.every(status => status.lastTest?.ok === true && !status.testStale);
  const jev = view?.providers.find(status => status.provider === 'jev');
  const dictation = view?.providers.filter(status => status.provider !== 'jev') ?? [];
  const field = (status: SpeedupStatus) => (
    <KeyField
      key={status.provider}
      status={status}
      value={drafts[status.provider] ?? ''}
      disabled={!idle}
      onChange={value => setDrafts(current => ({ ...current, [status.provider]: value }))}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="speedups">
      <p className="m-0 text-cell leading-base text-muted">
        Keys make Ferretry faster and cheaper. Nothing breaks without them. Each key goes to {machineName}’s secret
        store and is never shown again.
      </p>
      {failure !== null ? (
        <SetupNote live tone="warn" name="speedups-unreadable" title={`Couldn’t read ${machineName}’s keys`}>
          <span>{failure}</span>
        </SetupNote>
      ) : view === null ? (
        <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="speedups">
          Reading {machineName}’s speed-up keys…
        </p>
      ) : (
        <>
          {view.vault === 'ok' ? null : (
            <SetupNote tone="warn" name="speedups-vault" title="The secret store can’t be read">
              <span>Fix it in Secrets before pasting a key, or you may write over one that is still there.</span>
            </SetupNote>
          )}
          {jev === undefined ? null : (
            <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel">
              {field(jev)}
              <label className="flex min-w-0 items-start gap-2 text-cell text-fg" data-speedups-warden-jev="">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={warden}
                  disabled={!idle}
                  onChange={event => setWarden(event.target.checked)}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  Let the Warden use Jev (fractions of a cent per decision)
                </span>
              </label>
            </div>
          )}
          {dictation.length === 0 ? null : (
            <details
              className="kt-panel p-panel"
              data-speedups-dictation=""
              // A short key typed in here must not stay out of sight behind a closed heading.
              open={dictationOpen || unfinished.some(status => status.provider !== 'jev')}
              onToggle={event => setDictationOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer text-cell font-semibold text-fg">
                Dictation clean-up keys ({dictation.map(status => status.label).join(', ')})
              </summary>
              <div className="mt-3 flex min-w-0 flex-col gap-4">{dictation.map(field)}</div>
            </details>
          )}
        </>
      )}
      {unfinished.length === 0 ? null : (
        <p role="status" className="m-0 text-cell text-err" data-speedups-unfinished="">
          {listWords(unfinished.map(status => status.label))} {unfinished.length === 1 ? 'key looks' : 'keys look'} too
          short to be whole. Finish {unfinished.length === 1 ? 'it' : 'them'}, or clear the field, to save.
        </p>
      )}
      {problem === null ? null : (
        <p role="alert" className="m-0 text-cell text-err" data-speedups-problem="">
          {problem}
        </p>
      )}
      {revisit && idle ? (
        <PrimaryAction label="Continue" onClick={() => latest.current.onFinished(true)} name="continue" />
      ) : (
        <PrimaryAction
          label={busy === 'saving' ? 'Saving…' : busy === 'testing' ? 'Testing…' : 'Save keys'}
          disabled={!idle || typed.length === 0 || unfinished.length > 0 || view === null}
          onClick={() => void save()}
          name="save-keys"
        />
      )}
    </div>
  );
}
