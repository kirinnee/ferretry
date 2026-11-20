/**
 * Step `import-run`: the ONE import, applied once for Codex (never once per page), under `busy("Importing…")` for exactly as long
 * as the request is in flight (a refusal releases it, so Back, Later and a retry all work). It skips itself only when Codex is not
 * on this machine or has nothing to bring in any mode; starting fresh (reads nothing) and everything unticked are SHOWN, never
 * skipped, because a skip is persisted and drops the page for the run, and both follow a choice the person can still change by
 * going Back.
 * Everything the person chose on the kind pages is one `setup.import` change built by the kit; nothing is brought over until the
 * person presses the button.
 *
 * It lists what will come over (counts, by kind), names any kind that was never reviewed in this run (those are left out, and the
 * page says so), asks for the runtime's name (prefilled; none when Codex already has a runtime here), and afterwards shows each
 * file written or refused in the daemon's own words. The machine may ask for the passkey; that is the carrier's prompt.
 */
import { Button } from '@ferretry/app';
import { IMPORT_KINDS, ImportResultList, kindItemIds, useApplyImport } from '@ferretry/plugin-runtimes/import-kit';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingClient, StepHost } from '../onboarding-api.ts';
import { importingMode, importPlan, KIND_WORDS, nameProblem, type ImportMode } from './import-memory.ts';
import { ScanProblem } from './scan-problem.tsx';
import { useRunScan } from './use-run-scan.ts';

const sentenceOf = (taken: Readonly<Record<string, number>>, everything: boolean): string => {
  if (everything) return 'Everything your Codex holds: settings, models, AGENTS.md, skills and servers.';
  const parts = IMPORT_KINDS.filter(kind => (taken[kind] ?? 0) > 0).map(
    kind => `${KIND_WORDS[kind]} (${String(taken[kind])})`,
  );
  return parts.length === 0 ? 'Nothing.' : `${parts.join(', ')}.`;
};

/**
 * Starting fresh: nothing to bring, and nothing is read, so the page has nothing to do. It is passed over for THIS run
 * (`notNeeded`, not `skip`, which is recorded) so Back -> another choice still finds the import.
 */
function NotImporting({ step }: { readonly step: StepHost }) {
  useEffect(() => {
    step.notNeeded();
  }, [step]);
  return null;
}

export function ImportRunPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const mode = importingMode(step.segment);
  return mode === undefined ? <NotImporting step={step} /> : <RunBody client={client} step={step} mode={mode} />;
}

function RunBody({
  client,
  step,
  mode,
}: {
  readonly client: OnboardingClient;
  readonly step: StepHost;
  readonly mode: ImportMode;
}) {
  const scan = useRunScan(client, step);
  const { changes, applied, apply } = useApplyImport(client);
  const { model } = scan;
  const [name, setName] = useState<string | null>(null);
  const told = useRef<'none' | 'ready' | 'skipped'>('none');

  const typed = name ?? model?.suggestedName ?? '';
  const plan = useMemo(
    () => (model === null ? null : importPlan(model, mode, step.segment, typed)),
    [model, mode, step, typed],
  );
  // A scan with nothing to bring in ANY mode (stable: no choice here changes it), so skipping it is never undone by going Back.
  const nothingFound =
    model !== null &&
    IMPORT_KINDS.every(kind => kindItemIds(model, kind).length === 0) &&
    importPlan(model, 'everything', step.segment, typed).updates === 0;
  const total = plan === null ? 0 : IMPORT_KINDS.reduce((sum, kind) => sum + plan.taken[kind], 0);

  useEffect(() => {
    if (told.current === 'skipped') return;
    if (model === null || plan === null) {
      if ((scan.read.kind === 'confirm' || scan.read.kind === 'failed') && told.current === 'none') {
        told.current = 'ready';
        step.ready();
      }
      return;
    }
    if (!model.installed || nothingFound) {
      told.current = 'skipped';
      step.skip('not-needed');
      return;
    }
    if (told.current === 'none') {
      told.current = 'ready';
      step.ready();
    }
  }, [scan.read.kind, model, plan, nothingFound, step]);

  const problem = model !== null && model.duplicateOf === null ? nameProblem(typed) : null;

  const run = async (): Promise<void> => {
    if (model === null || plan === null || problem !== null) return;
    step.busy('Importing…');
    const result = await apply(plan.change, 'Codex').finally(() => step.busy(null));
    if (result !== null) step.done();
  };

  return (
    <section aria-label="Bring Codex over" className="flex max-w-xl flex-col gap-3" data-codex-step="import-run">
      <ScanProblem read={scan.read} look={scan.look} />
      {model !== null && plan !== null ? (
        <>
          <p className="m-0 text-ui text-fg" data-import-summary="">
            Coming over: {sentenceOf(plan.taken, mode === 'everything')}
          </p>
          {plan.unreviewed.length === 0 ? null : (
            <p className="m-0 text-cell text-warn" data-import-unreviewed="">
              Left out, because you did not look at {plan.unreviewed.map(kind => KIND_WORDS[kind]).join(', ')} this
              time. Go back to choose them.
            </p>
          )}
          <p className="m-0 text-cell text-muted">One way: your Codex files are read and never changed.</p>
          {total === 0 && plan.updates === 0 ? null : model.duplicateOf === null ? (
            <label className="flex max-w-sm flex-col gap-1 text-cell text-muted">
              Name for this Codex runtime
              <input
                className="kt-input min-h-11 text-ui"
                value={typed}
                maxLength={200}
                disabled={applied !== null || changes.busy}
                data-import-name=""
                onChange={event => setName(event.currentTarget.value)}
              />
            </label>
          ) : (
            <p className="m-0 text-cell text-muted" data-import-existing="">
              Codex already has a runtime here ({model.duplicateOf}); this adds to it.
            </p>
          )}
          {problem === null || applied !== null ? null : (
            <p role="alert" className="m-0 text-cell text-warn" data-import-name-problem="">
              {problem}
            </p>
          )}
          {changes.authority?.kind === 'step-up' && applied === null ? (
            <p className="m-0 text-cell text-muted" data-import-step-up="">
              This machine will ask you to confirm with your passkey when you bring it over.
            </p>
          ) : null}
          {changes.refusal === null ? null : (
            <p role="alert" className="m-0 text-cell text-err" data-import-refusal="">
              {changes.refusal}
            </p>
          )}
          {applied !== null ? (
            <div className="flex flex-col gap-2" data-import-done={applied.kind}>
              <p className="m-0 text-ui text-fg">
                {applied.kind === 'already-in' ? 'Nothing new: Codex is already set up.' : 'Codex is brought over.'}
              </p>
              <ImportResultList sentences={applied.sentences} />
            </div>
          ) : total === 0 && plan.updates === 0 ? null : (
            <div>
              <Button
                type="button"
                variant="primary"
                className="min-h-11 py-3"
                disabled={changes.busy || problem !== null}
                data-import-run=""
                onClick={() => void run()}
              >
                {changes.busy ? 'Importing…' : 'Bring it over'}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
