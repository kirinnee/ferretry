/**
 * "Let the Warden watch your ferrets?" — the Warden's one first-run page. Three stacked cards (the shell's ChoiceCards):
 * Rules only (free), + Jev, + LLM investigation, the demo on the right (`StepDemo`), and, once a card that uses Jev is
 * picked, Voice's own Jev key row right under the cards (`keyRow`: the page mounts it and never holds the value).
 *
 * Choosing writes nothing. The page registers what Next must SAVE (`step.commit`, contract rule 8): `warden.yaml`'s
 * `enabled` and the two layers, and, when the Jev key is stored but not named in it, naming it. A Jev answer with no key
 * saved asks ONCE, in the footer line, "Go on without a Jev key?": Next again says yes. The page is skipped
 * (`already-set`) when `warden.yaml` is already on the machine, so it never writes over what is saved.
 */
import { ChoiceCards, StepDemo } from '@ferretry/app';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { StepHost } from '@ferretry/kernel/contract';
import type { SpeedupsView } from '../../lib/speedups.ts';
import type { WardenClient } from '../../lib/warden-client.ts';
import { Button } from '../../ui.ts';
import { jevKeyStatus } from '../warden/warden-config-card.tsx';
import { WardenDemo } from './warden-demo.tsx';
import {
  choiceOf,
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
  /** Voice's Jev key row, drawn under the cards while a card that uses Jev is picked. The page never sees what is typed in it. */
  readonly keyRow?: ReactNode;
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** What Next says, once, when Jev is picked and no key is saved: the answer to it is Next again. */
const NO_KEY_QUESTION = 'No Jev key yet. Go on without one? Press Next to say yes, or paste a key above.';

export function WardenStepPage({ deps, step, keyRow }: WardenStepPageProps) {
  const [choice, setChoice] = useState<WardenChoice | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Whether the person was already asked about going on without a Jev key (the next Next is their yes). */
  const asked = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(null);
    try {
      // A file that cannot be read is NOT a file that is not there: the page says so rather than offer to write over it.
      const [file, view] = await Promise.all([deps.readFile(), deps.client.config()]);
      if (wardenFileExists(file)) {
        step?.skip('already-set');
        return;
      }
      setChoice(choiceOf(view.config));
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

  // What Next saves follows the pick.
  useEffect(() => {
    if (choice === null || step === undefined) return;
    step.commit(async () => {
      if (choice !== 'rules') {
        // The key is read fresh: it may have been saved in the row since the page loaded.
        const [view, speedups] = await Promise.all([deps.client.config(), deps.readKey().catch(() => null)]);
        const key = jevKeyStatus(speedups, view.jevKey);
        if (key.state === 'missing' && !asked.current) {
          asked.current = true;
          throw new Error(NO_KEY_QUESTION);
        }
        await deps.client.updateConfig(patchFor(choice));
        // Stored but not named: the Warden spends nothing until `warden.yaml` names it, and this Next is the person's yes.
        if (key.state === 'not_named') await deps.client.nameJevKey();
        return;
      }
      await deps.client.updateConfig(patchFor(choice));
    });
  }, [choice, deps, step]);

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
  if (choice === null) return null;

  return (
    <div className="wd-step" data-onboarding-step="warden.warden">
      <ChoiceCards
        label="How the Warden helps"
        layout="stack"
        options={WARDEN_CHOICES.map(({ id, title, line }) => ({ id, title, line }))}
        value={choice}
        onChange={next => {
          // A new pick starts the key question over.
          asked.current = false;
          setChoice(next as WardenChoice);
        }}
      />
      <StepDemo>
        <WardenDemo key={choice} choice={choice} />
      </StepDemo>
      {choice === 'rules' ? null : <div data-warden-key-row="">{keyRow}</div>}
    </div>
  );
}
