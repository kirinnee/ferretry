/**
 * "Let the Warden watch your ferrets?" — the Warden's one first-run page. Three cards (the shell's ChoiceCards): Rules
 * only (free), + Jev, + LLM investigation. An answer is written at once to `warden.yaml` (only `enabled` and the two
 * layers) and the page tells its host `done()`. The page is skipped (`already-set`) when the person has already
 * written the file. No key is typed here: a Jev key is entered once, in Settings › Speed-ups, and this page only
 * says whether it is there and offers to name it in `warden.yaml`.
 */
import { ChoiceCards } from '@ferretry/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepHost } from '@ferretry/kernel/contract';
import type { SpeedupsView } from '../../lib/speedups.ts';
import type { WardenClient } from '../../lib/warden-client.ts';
import type { WardenConfigView } from '../../wire.ts';
import { Button, RouteLink } from '../../ui.ts';
import { jevKeyStatus } from '../warden/warden-config-card.tsx';
import type { JevKeyStatus } from '../warden/warden-settings-model.ts';
import { WardenDemo } from './warden-demo.tsx';
import { choiceOf, patchFor, WARDEN_CHOICES, type WardenChoice, wardenFileWritten } from './warden-step-model.ts';
import './warden-step.css';

/** What the page reads and writes, so a test hands its own: the Warden's routes, `warden.yaml` as written, the Jev key. */
export interface WardenStepDeps {
  readonly client: WardenClient;
  readonly readFile: () => Promise<{ readonly exists: boolean; readonly written?: unknown }>;
  readonly readKey: () => Promise<SpeedupsView | 'off'>;
}

export interface WardenStepPageProps {
  readonly deps: WardenStepDeps;
  readonly step?: StepHost | undefined;
  /** Where the Jev key is entered (Settings › Speed-ups on this machine). */
  readonly speedupsHref?: string | undefined;
  readonly onNavigate?: ((to: string) => void) | undefined;
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** What happens to a flag when Jev has no key: said in the words of the settings summary. */
const NO_KEY_FALLBACK: Readonly<Record<WardenChoice, string>> = {
  rules: '',
  jev: 'every flag is shown to you',
  llm: 'every flag goes to the investigation',
};

interface Loaded {
  readonly view: WardenConfigView;
  readonly jevKey: JevKeyStatus;
}

export function WardenStepPage({ deps, step, speedupsHref, onNavigate }: WardenStepPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choice, setChoice] = useState<WardenChoice | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(null);
    try {
      const [file, view, speedups] = await Promise.all([
        deps.readFile().catch(() => ({ exists: false })),
        deps.client.config(),
        deps.readKey().catch(() => null),
      ]);
      if (wardenFileWritten(file)) {
        step?.skip('already-set');
        return;
      }
      setLoaded({ view, jevKey: jevKeyStatus(speedups, view.jevKey) });
      step?.ready();
    } catch (cause) {
      setFailed(reasonOf(cause));
      step?.ready();
    }
  }, [deps, step]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const choose = async (next: WardenChoice): Promise<void> => {
    if (loaded === null) return;
    const before = choice;
    setChoice(next);
    setNote(null);
    setSaving(true);
    step?.busy('Saving…');
    try {
      const answer = await deps.client.updateConfig(patchFor(next));
      const held = answer.held ?? [];
      if (held.length > 0) setNote(`Saved, but it waits for you to confirm it: ${held.join('; ')}.`);
      setLoaded({ view: answer, jevKey: jevOf(answer, loaded.jevKey) });
      step?.done();
    } catch (cause) {
      setChoice(before);
      setNote(reasonOf(cause));
    } finally {
      setSaving(false);
      step?.busy(null);
    }
  };

  const nameStoredKey = async (): Promise<void> => {
    setNaming(true);
    setNote(null);
    try {
      const answer = await deps.client.nameJevKey();
      const held = answer.held ?? [];
      if (held.length > 0) setNote(`Waiting for your approval: ${held.join('; ')}.`);
      setLoaded(current =>
        current === null
          ? current
          : { view: answer, jevKey: answer.jevKey === 'named' ? { ...current.jevKey, state: 'set' } : current.jevKey },
      );
    } catch (cause) {
      setNote(reasonOf(cause));
    } finally {
      setNaming(false);
    }
  };

  if (failed !== null)
    return (
      <div className="wd-step" data-onboarding-step="warden.warden">
        <p role="alert" className="wd-step__line">
          {failed}
        </p>
        <div className="wd-step__note">
          <Button onClick={() => void load()}>Try again</Button>
        </div>
      </div>
    );
  if (loaded === null) return null;

  const demoChoice = choice ?? choiceOf(loaded.view.config);
  return (
    <div className="wd-step" data-onboarding-step="warden.warden">
      <p className="wd-step__line">
        The Warden checks on your ferrets every couple of minutes and flags the ones that are stuck or have died. Pick
        how much help it gets. You can change this any time in Settings › Warden.
      </p>
      <ChoiceCards
        label="How the Warden helps"
        options={WARDEN_CHOICES.map(({ id, title, line }) => ({ id, title, line }))}
        value={choice}
        onChange={next => void choose(next as WardenChoice)}
        disabled={saving}
      />
      {choice === null ? null : <WardenDemo key={choice} choice={demoChoice} />}
      {choice === null || choice === 'rules' ? null : (
        <JevNote
          choice={choice}
          jevKey={loaded.jevKey}
          naming={naming}
          speedupsHref={speedupsHref}
          onNavigate={onNavigate}
          onUseStoredKey={() => void nameStoredKey()}
        />
      )}
      {note === null ? null : (
        <p role="status" className="wd-step__line">
          {note}
        </p>
      )}
    </div>
  );
}

const jevOf = (answer: WardenConfigView, was: JevKeyStatus): JevKeyStatus =>
  answer.jevKey === 'named' && was.state === 'not_named' ? { ...was, state: 'set' } : was;

function JevNote({
  choice,
  jevKey,
  naming,
  speedupsHref,
  onNavigate,
  onUseStoredKey,
}: {
  readonly choice: WardenChoice;
  readonly jevKey: JevKeyStatus;
  readonly naming: boolean;
  readonly speedupsHref: string | undefined;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly onUseStoredKey: () => void;
}) {
  const fallback = NO_KEY_FALLBACK[choice];
  const add =
    speedupsHref === undefined ? (
      <span>Add one in Settings › Speed-ups.</span>
    ) : (
      <RouteLink to={speedupsHref} {...(onNavigate === undefined ? {} : { onNavigate })}>
        Add one in Settings › Speed-ups
      </RouteLink>
    );
  switch (jevKey.state) {
    case 'set':
      return (
        <div className="wd-step__note" data-warden-jev="set">
          <p>Jev has its key.</p>
        </div>
      );
    case 'not_named':
      return (
        <div className="wd-step__note" data-warden-jev="not_named">
          <p>A Jev key is stored, but the Warden is not told to use it, so {fallback} until it is.</p>
          <Button onClick={onUseStoredKey} disabled={naming}>
            {naming ? 'Using it…' : 'Use the stored key'}
          </Button>
        </div>
      );
    case 'missing':
      return (
        <div className="wd-step__note" data-warden-jev="missing">
          <p>
            No Jev key yet. It is optional: until you add one, {fallback}. {add}
            {jevKey.keyUrl === undefined ? '.' : `, then get a key at ${jevKey.keyUrl}.`}
          </p>
        </div>
      );
    case 'off':
      return (
        <div className="wd-step__note" data-warden-jev="off">
          <p>Jev keys are kept in Speed-ups, which is switched off on this machine, so {fallback}.</p>
        </div>
      );
    default:
      return (
        <div className="wd-step__note" data-warden-jev="unknown">
          <p>Could not check for a Jev key. {add}</p>
        </div>
      );
  }
}
