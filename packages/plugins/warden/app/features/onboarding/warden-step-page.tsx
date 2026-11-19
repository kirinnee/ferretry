/**
 * "Let the Warden watch your ferrets?" — the Warden's one first-run page. Three cards (the shell's ChoiceCards): Rules
 * only (free), + Jev, + LLM investigation. An answer is written at once to `warden.yaml` (only `enabled` and the two
 * layers). The page is skipped (`already-set`) when `warden.yaml` is already on the machine, so it never writes over
 * what is saved. No key is typed here: a Jev key is entered once, in Settings › Speed-ups, and this page only says
 * whether it is there and offers to name it in `warden.yaml`.
 *
 * The host is told `done()` once the answer is saved, EXCEPT when the answer uses Jev and the key is still to settle
 * (stored but not named, or not stored yet): then the step stays open under `busy()`, with the key buttons reachable
 * without picking the card again, until the key is named or the person goes on without it. Only then `done()`.
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
import {
  choiceOf,
  keyStillOpen,
  patchFor,
  WARDEN_CHOICES,
  type WardenChoice,
  type WardenFileRead,
  wardenFileExists,
} from './warden-step-model.ts';
import './warden-step.css';

/** What the page reads and writes, so a test hands its own: the Warden's routes, `warden.yaml` as written, the Jev key. */
export interface WardenStepDeps {
  readonly client: WardenClient;
  readonly readFile: () => Promise<WardenFileRead>;
  readonly readKey: () => Promise<SpeedupsView | 'off'>;
}

export interface WardenStepPageProps {
  readonly deps: WardenStepDeps;
  readonly step?: StepHost | undefined;
  /** Where the Jev key is entered (Settings › Speed-ups on this machine). */
  readonly speedupsHref?: string | undefined;
  readonly onNavigate?: ((to: string) => void) | undefined;
}

/** What the host shows while the page waits on the Jev key. */
const HOLD_LABEL = 'Waiting for the Jev key…';

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
  const [checking, setChecking] = useState(false);
  /** Whether the step is held open for the Jev key (the host was told `busy` and not yet `done`). */
  const [holding, setHolding] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(null);
    try {
      // A file that cannot be read is NOT a file that is not there: the page says so rather than offer to write over it.
      const [file, view, speedups] = await Promise.all([
        deps.readFile(),
        deps.client.config(),
        deps.readKey().catch(() => null),
      ]);
      if (wardenFileExists(file)) {
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

  /** The answer is settled: let go of the step and tell the host. */
  const finish = (): void => {
    setHolding(false);
    step?.busy(null);
    step?.done();
  };

  /** The answer is saved, but the Jev key is still open: hold the step (no `done`) until it is named or declined. */
  const hold = (): void => {
    setHolding(true);
    step?.busy(HOLD_LABEL);
  };

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
      const jevKey = jevOf(answer, loaded.jevKey);
      setLoaded({ view: answer, jevKey });
      if (keyStillOpen(next, jevKey.state)) hold();
      else finish();
    } catch (cause) {
      setChoice(before);
      setNote(reasonOf(cause));
      step?.busy(holding ? HOLD_LABEL : null);
    } finally {
      setSaving(false);
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
      // Asked for: whether it is applied now or waits for the owner, the key is no longer this page's to settle.
      finish();
    } catch (cause) {
      setNote(reasonOf(cause));
    } finally {
      setNaming(false);
    }
  };

  /** Reads the key and the settings again, so a key saved in Speed-ups meanwhile shows without picking the card again. */
  const checkKey = async (): Promise<void> => {
    setChecking(true);
    setNote(null);
    try {
      const [view, speedups] = await Promise.all([deps.client.config(), deps.readKey().catch(() => null)]);
      const jevKey = jevKeyStatus(speedups, view.jevKey);
      setLoaded({ view, jevKey });
      if (holding && !keyStillOpen(choice ?? 'rules', jevKey.state)) finish();
    } catch (cause) {
      setNote(reasonOf(cause));
    } finally {
      setChecking(false);
    }
  };

  /** "Go on without a key": the person has said Jev may stay keyless, so the step is done. */
  const goOnWithoutKey = (): void => {
    setNote(null);
    finish();
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
          checking={checking}
          holding={holding}
          speedupsHref={speedupsHref}
          onNavigate={onNavigate}
          onUseStoredKey={() => void nameStoredKey()}
          onCheck={() => void checkKey()}
          onGoOn={goOnWithoutKey}
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
  checking,
  holding,
  speedupsHref,
  onNavigate,
  onUseStoredKey,
  onCheck,
  onGoOn,
}: {
  readonly choice: WardenChoice;
  readonly jevKey: JevKeyStatus;
  readonly naming: boolean;
  readonly checking: boolean;
  /** The step is held open for this key: "go on without it" is offered. */
  readonly holding: boolean;
  readonly speedupsHref: string | undefined;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly onUseStoredKey: () => void;
  readonly onCheck: () => void;
  readonly onGoOn: () => void;
}) {
  const goOn = holding ? (
    <Button onClick={onGoOn} disabled={naming || checking}>
      Go on without a key
    </Button>
  ) : null;
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
          <p>A Jev key is stored, but the Warden is not set to use it yet, so {fallback} until you press the button.</p>
          <Button onClick={onUseStoredKey} disabled={naming}>
            {naming ? 'Using it…' : 'Use the stored key'}
          </Button>
          {goOn}
        </div>
      );
    case 'missing':
      return (
        <div className="wd-step__note" data-warden-jev="missing">
          <p>
            No Jev key yet. It is optional: until you add one, {fallback}. {add}
            {jevKey.keyUrl === undefined ? '.' : `, then get a key at ${jevKey.keyUrl}.`}
          </p>
          <Button onClick={onCheck} disabled={checking}>
            {checking ? 'Looking…' : 'Check again'}
          </Button>
          {goOn}
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
