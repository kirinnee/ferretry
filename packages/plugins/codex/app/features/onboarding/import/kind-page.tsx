/**
 * The five "choose what to import" pages (settings, models, AGENTS.md, skills, MCP servers), one component for all of them.
 * Each shows what the scan found of its ONE kind as a checklist with what each thing becomes, and says nothing else.
 *
 * It follows the CURRENT `importMode`, never a choice that can still change: when the person chose Import everything or Start
 * fresh in this run it reads nothing, draws nothing and calls `notNeeded()` (contract rule 7), so Import everything is ONE page
 * (the run page) and not five notice pages. A run with no `importMode` at all (a reload dropped the memory) draws the checklist
 * exactly as Customize does, every item ticked as Import everything would bring it: never a chooser, never a Continue. Every
 * shown page is answered only by its own footer Next; a tick writes the segment memory and nothing else. It never `skip()`s for that: a skip is recorded and the page would be gone for the
 * rest of the run, so Back -> Customize could not reach it; the `notNeeded` mark is this run's only and is cleared when the
 * mode changes. It skips itself (`not-needed`) only when the scan found
 * nothing of its kind, which no choice here changes. Nothing is written here: what is left unticked is the segment memory (`review.<kind>`),
 * and the one import happens once, at `import-run`. A scan that wants the passkey waits for the person's own press; a scan that
 * failed says so and offers a retry, so a page never hangs under its loading cover.
 */
import type { ImportItemId } from '@ferretry/plugin-runtimes/contract';
import { FoundKindList, type ImportKind, kindFound } from '@ferretry/plugin-runtimes/import-kit';
import { useEffect, useRef, useState } from 'react';
import type { OnboardingClient, StepHost } from '../onboarding-api.ts';
import { importingMode, KIND_WORDS, rememberReview, reviewOf, STEP_OF_KIND } from './import-memory.ts';
import { ScanProblem } from './scan-problem.tsx';
import { useRunScan } from './use-run-scan.ts';

const LEAD: Readonly<Record<ImportKind, string>> = {
  settings: 'Your Codex settings file. Untick what you would rather set up again here.',
  'model-set': 'The models your settings name, and each Codex profile.',
  instructions: 'Your AGENTS.md, the standing instructions every Codex session reads.',
  skills: 'The skills in your Codex.',
  mcp: 'The MCP servers your Codex is set up with.',
};

/**
 * Not choosing (everything, or fresh in this run): the page has nothing to ask and reads nothing. It is passed over for THIS run
 * (`notNeeded`, never `skip`, which would persist and drop it for the run), and a later Back -> Customize clears the mark
 * because the mode changed, so the page is there again.
 */
function NotChoosing({ step }: { readonly step: StepHost }) {
  useEffect(() => {
    step.notNeeded();
  }, [step]);
  return null;
}

export function KindPage({
  client,
  step,
  kind,
}: {
  readonly client: OnboardingClient;
  readonly step: StepHost;
  readonly kind: ImportKind;
}) {
  const mode = importingMode(step.segment);
  return mode === 'choose' || mode === 'recovered' ? (
    <KindBody client={client} step={step} kind={kind} />
  ) : (
    <NotChoosing step={step} />
  );
}

function KindBody({
  client,
  step,
  kind,
}: {
  readonly client: OnboardingClient;
  readonly step: StepHost;
  readonly kind: ImportKind;
}) {
  const scan = useRunScan(client, step);
  const earlier = reviewOf(step.segment, kind);
  const [left, setLeft] = useState<ReadonlySet<ImportItemId>>(() => new Set(earlier?.left));
  const [tickedEnv, setTickedEnv] = useState<ReadonlySet<string>>(() => new Set(earlier?.env));
  const told = useRef<'none' | 'ready' | 'skipped'>('none');
  const seeded = useRef(false);

  const { read, model } = scan;
  const found = model !== null && kindFound(model, kind);
  useEffect(() => {
    if (told.current === 'skipped') return;
    if (model === null) {
      if ((read.kind === 'confirm' || read.kind === 'failed') && told.current === 'none') {
        told.current = 'ready';
        step.ready();
      }
      return;
    }
    if (!found) {
      told.current = 'skipped';
      step.skip('not-needed');
      return;
    }
    if (!seeded.current) {
      // What is on screen is the answer: Next with every box as it stands records exactly this.
      seeded.current = true;
      rememberReview(step, kind, { left: [...left], env: [...tickedEnv] });
    }
    if (told.current === 'none') {
      told.current = 'ready';
      step.ready();
    }
  }, [read.kind, model, found, step, kind, left, tickedEnv]);

  const answer = (nextLeft: ReadonlySet<ImportItemId>, nextEnv: ReadonlySet<string>): void => {
    setLeft(nextLeft);
    setTickedEnv(nextEnv);
    rememberReview(step, kind, { left: [...nextLeft], env: [...nextEnv] });
  };

  const settingsLeftOut =
    kind === 'model-set' &&
    model !== null &&
    reviewOf(step.segment, 'settings')?.left.includes(`${model.harness}:settings`) === true;
  return (
    <section
      aria-label={`Import Codex ${KIND_WORDS[kind]}`}
      className="flex max-w-xl flex-col gap-3"
      data-codex-step={STEP_OF_KIND[kind]}
      data-import-kind={kind}
    >
      <ScanProblem read={read} look={scan.look} />
      {model !== null && found ? (
        <>
          <p className="m-0 text-cell text-muted">{LEAD[kind]}</p>
          {settingsLeftOut ? (
            <p className="m-0 text-cell text-muted" data-import-settings-left="">
              You left Settings out, so the models they name are left out too.
            </p>
          ) : null}
          <FoundKindList
            model={model}
            kind={kind}
            left={left}
            onToggle={(id, on) => {
              const next = new Set(left);
              if (on) next.delete(id);
              else next.add(id);
              answer(next, tickedEnv);
            }}
            tickedEnv={tickedEnv}
            onTickEnv={(name, on) => {
              const next = new Set(tickedEnv);
              if (on) next.add(name);
              else next.delete(name);
              answer(left, next);
            }}
          />
        </>
      ) : null}
    </section>
  );
}
