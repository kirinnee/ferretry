/**
 * Step `import-run`: the ONE import, applied once for Codex (never once per page), under `busy("Importing…")` for exactly as long
 * as the request is in flight (a refusal releases it, so Back, Later and a retry all work). It skips itself only when Codex is not
 * on this machine or has nothing to bring in any mode; starting fresh (reads nothing) and everything unticked are SHOWN, never
 * skipped, because a skip is persisted and drops the page for the run, and both follow a choice the person can still change by
 * going Back.
 * Everything the person chose on the kind pages is one `setup.import` change built by the kit; nothing is brought over until the
 * person presses Import. The same page, words and buttons as Claude Code's: how many items come over and how many are left out,
 * what Next does, the runtime's name (prefilled; none when Codex already has a runtime here), the one Import action (the flow's
 * footer Later / Next is how a person leaves the import, so the page draws no second "skip" row), and afterwards each file written
 * or refused in the daemon's own words. The machine may ask for the passkey; that is the carrier's prompt.
 *
 * It names any kind whose checklist was never shown in this run (those are NOT left out, since nobody left them out).
 */
import { Button } from '@ferretry/app';
import { ActionRow } from '@ferretry/app/ui';
import {
  IMPORT_KINDS,
  ImportResultList,
  kindItemIds,
  NEXT_LEAVES,
  RuntimeNameField,
  StepBody,
  StepLine,
  useApplyImport,
} from '@ferretry/plugin-runtimes/import-kit';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingClient, StepHost } from '../onboarding-api.ts';
import { importingMode, importPlan, KIND_WORDS, nameProblem, type ImportMode } from './import-memory.ts';
import { ScanProblem } from './scan-problem.tsx';
import { useRunScan } from './use-run-scan.ts';

const items = (count: number): string => `${String(count)} ${count === 1 ? 'item' : 'items'}`;

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
  const found = model === null ? 0 : IMPORT_KINDS.reduce((sum, kind) => sum + kindItemIds(model, kind).length, 0);

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

  const nothingToImport = total === 0 && (plan?.updates ?? 0) === 0;
  return (
    <StepBody step="codex.import-run" label="Bring Codex over" data-codex-step="import-run">
      <ScanProblem read={scan.read} look={scan.look} />
      {model !== null && plan !== null ? (
        applied !== null ? (
          <div role="status" data-import-done={applied.kind}>
            <StepLine>
              {applied.kind === 'already-in'
                ? 'Nothing new to bring in: it is already set up.'
                : 'Codex is set up here.'}
            </StepLine>
            <ImportResultList sentences={applied.sentences} />
          </div>
        ) : (
          <>
            <StepLine data-import-count="" data-import-summary="">
              {`Bringing ${items(total)}${found - total <= 0 ? '' : `, leaving out ${String(found - total)}`}. Hooks are never imported.`}
            </StepLine>
            {plan.unreviewed.length === 0 ? null : (
              <StepLine role="note" data-import-unreviewed="">
                You did not look at {plan.unreviewed.map(kind => KIND_WORDS[kind]).join(', ')} this time, so they come
                over as found. Go back to look at them first.
              </StepLine>
            )}
            <StepLine data-import-next="">{NEXT_LEAVES}</StepLine>
            {nothingToImport ? null : model.duplicateOf === null ? (
              <RuntimeNameField value={typed} invalid={problem !== null} disabled={changes.busy} onChange={setName} />
            ) : (
              <StepLine data-import-existing="">
                {`A runtime named ${model.duplicateOf} already uses this setup, so no second one is added.`}
              </StepLine>
            )}
            {problem === null ? null : (
              <StepLine role="alert" data-import-name-problem="">
                {problem}
              </StepLine>
            )}
            {changes.authority?.kind === 'step-up' ? (
              <StepLine data-import-step-up="">
                This machine will ask you to confirm with your passkey when you import.
              </StepLine>
            ) : null}
            {changes.refusal === null ? null : (
              <StepLine role="alert" data-import-refusal="">
                {changes.refusal}
              </StepLine>
            )}
            {changes.busy ? <StepLine role="status">Importing…</StepLine> : null}
            {/* One way on here: the footer's Later (and Next) are the way to leave the import, so no second "skip" row. */}
            {nothingToImport ? null : (
              <ActionRow
                primary={
                  <Button
                    variant="primary"
                    disabled={changes.busy || problem !== null}
                    data-import-run=""
                    onClick={() => void run()}
                  >
                    Import
                  </Button>
                }
              />
            )}
          </>
        )
      ) : null}
    </StepBody>
  );
}
