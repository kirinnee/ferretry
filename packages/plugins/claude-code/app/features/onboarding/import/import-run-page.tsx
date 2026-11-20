/**
 * "Bring it over": the ONE act of the import. It sends one `setup.import` (the harness, the left-out ids the pages
 * gathered, the GitHub tokens the person ticked, the runtime name) through the ordinary change path, under `busy` only
 * while that request is in flight, then lists each file written or refused in the daemon's own words. Nothing happens on
 * a card pick or an arrow key: only the Import press.
 *
 *   - `importMode` `fresh`: nothing is imported. The page stays in the run and says so (a skip is irreversible in the
 *     flow, and Back may still change the mode); Next records it done.
 *   - `everything`: nothing is left out and no GitHub token is taken.
 *   - `choose`: what the pages left out is left out. Leaving Settings out also leaves the model set those settings name
 *     (the r9 wizard's own rule; the daemon derives the models from them).
 *   - missing (a reload dropped the run's memory, owner add 5): it asks again: what was found, or nothing now. "What was
 *     found" is still a SELECTIVE import: it leaves out whatever the kind pages shown after the reload had unticked.
 * Back and Later are never held. Next is not held either (the contract has no way to hold Next alone): before Import is
 * pressed the page says that Next leaves the import for later, so a Next press never records "done" over an import the
 * page did not name.
 */
import { Button, ChoiceCards, type ChoiceOption } from '@ferretry/app';
import {
  buildImportChange,
  ImportResultList,
  IMPORT_KINDS,
  kindItemIds,
  nameProblem,
  useApplyImport,
  useHarnessScan,
} from '@ferretry/plugin-runtimes/import-kit';
import { importItemId, type ImportItemId } from '@ferretry/plugin-runtimes/contract';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import { importModeOf } from '../import-choice-page.tsx';
import type { StepPageProps } from '../props.ts';
import { allLeft, HARNESS, SCAN_RUN, tickedEnvOf } from './segment.ts';

const FRESH = 'Not needed for a fresh start. Go back to bring something over.';
const NEXT_LEAVES = 'Next leaves the import for later. You can import any time from Settings › Runtimes › Import.';

const ASK: readonly ChoiceOption[] = [
  {
    id: 'everything',
    title: 'Import what was found',
    line: 'Settings, models, CLAUDE.md, skills and MCP servers, except what you left out on the pages you just saw.',
  },
  { id: 'nothing', title: 'Import nothing now', line: 'To choose one by one, use Settings › Runtimes › Import.' },
];

type Asked = 'everything' | 'nothing';

/** The ids this import leaves out: what the pages left out, plus the model set when its settings are left out. */
export const skipOf = (left: ReadonlySet<ImportItemId>): readonly ImportItemId[] => {
  const settings = importItemId(HARNESS, 'settings');
  return left.has(settings) ? [...left, importItemId(HARNESS, 'model-set')] : [...left];
};

export function ImportRunPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const { read, model, look, rescan } = useHarnessScan(client, HARNESS, SCAN_RUN);
  const imports = useApplyImport(client);
  const mode = importModeOf(step?.segment ?? {});
  const [asked, setAsked] = useState<Asked | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [end, setEnd] = useState<'imported' | 'already-in' | 'left' | null>(null);
  const [sentences, setSentences] = useState<readonly string[]>([]);
  const [working, setWorking] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || step === undefined) return;
    if (mode === 'fresh') {
      decided.current = true;
      step.ready();
      return;
    }
    if (read.kind === 'idle' || read.kind === 'reading') return;
    decided.current = true;
    // Only what Back cannot change: Claude Code is not on this computer at all.
    if (read.kind === 'ready' && model !== null && !model.installed) return step.skip('not-needed');
    step.ready();
  }, [read.kind, model, mode, step]);

  if (mode === 'fresh')
    return (
      <div className="cc-step" data-onboarding-step="claude-code.import-run">
        <p className="cc-step__line" data-import-fresh="">
          {FRESH}
        </p>
      </div>
    );
  if (read.kind === 'idle' || read.kind === 'reading') return null;

  // After a reload the person's one-by-one choices are gone, but the kind pages shown since then remembered theirs: "what was
  // found" is the selective import over those, never a blind "everything".
  const plan: 'everything' | 'choose' | 'nothing' | null =
    mode === undefined ? (asked === 'everything' ? 'choose' : asked) : mode;
  const everything = plan === 'everything';
  const left = everything ? new Set<ImportItemId>() : allLeft(step?.segment ?? {});
  const skip = skipOf(left);
  const ids = model === null ? [] : [...new Set(IMPORT_KINDS.flatMap(kind => kindItemIds(model, kind)))];
  const leaving = ids.filter(id => skip.includes(id)).length;
  const name = typed ?? model?.suggestedName ?? `${HARNESS}-default`;
  const named = model !== null && model.duplicateOf === null;
  const invalid = named ? nameProblem(name) : null;
  const canImport = model !== null && (plan === 'everything' || plan === 'choose') && invalid === null && !working;

  const bringIn = async (): Promise<void> => {
    if (model === null || (plan !== 'everything' && plan !== 'choose')) return;
    setWorking(true);
    step?.busy('Importing…');
    const change = buildImportChange(HARNESS, [HARNESS], skip, named ? name : '', {
      tickedEnv: everything ? [] : [...tickedEnvOf(step?.segment ?? {})],
    });
    const done = await imports.apply(change, model.label);
    setWorking(false);
    if (done === null) return void step?.busy(null); // refused: the reason is on the page, Back and Later stay free
    setSentences(done.sentences);
    setEnd(done.kind);
    void rescan(false);
    step?.busy(null);
    step?.done();
  };

  const leave = (): void => {
    setEnd('left');
    step?.done();
  };

  return (
    <div className="cc-step" data-onboarding-step="claude-code.import-run">
      {read.kind !== 'ready' || model === null ? (
        <div className="cc-actions">
          <p role={read.kind === 'failed' ? 'alert' : undefined} className="cc-step__line">
            {read.kind === 'failed'
              ? read.sentence
              : 'Ferretry needs your OK before it reads what Claude Code keeps on this computer.'}
          </p>
          <Button variant={read.kind === 'confirm' ? 'primary' : undefined} onClick={() => void look()}>
            {read.kind === 'confirm' ? 'Show what is there' : 'Try again'}
          </Button>
          <Button onClick={leave}>Skip the import</Button>
        </div>
      ) : end === 'imported' || end === 'already-in' ? (
        <div role="status" data-import-answer={end}>
          <p className="cc-step__line">
            {end === 'already-in' ? 'Nothing new to bring in: it is already set up.' : 'Claude Code is set up here.'}
          </p>
          <ImportResultList sentences={sentences} />
        </div>
      ) : end === 'left' ? (
        <p className="cc-step__line" data-import-left="">
          Nothing was imported. You can import later from Settings › Runtimes › Import.
        </p>
      ) : (
        <>
          {mode === undefined ? (
            <>
              <p className="cc-step__line" role="note" data-import-lost="">
                This page was reloaded, so Ferretry no longer knows what you chose earlier. What do you want to do?
              </p>
              <ChoiceCards
                label="What to bring over"
                options={ASK}
                value={asked}
                onChange={next => setAsked(next === 'everything' ? 'everything' : 'nothing')}
              />
            </>
          ) : null}
          {plan === 'everything' || plan === 'choose' ? (
            <p className="cc-step__line" data-import-count="">
              {`Bringing ${String(ids.length - leaving)} ${ids.length - leaving === 1 ? 'item' : 'items'}${
                leaving === 0 ? '' : `, leaving out ${String(leaving)}`
              }. Hooks are never imported.`}
            </p>
          ) : null}
          <p className="cc-step__line" data-import-next="">
            {NEXT_LEAVES}
          </p>
          {named && plan !== 'nothing' ? (
            <label className="cc-field">
              Runtime name
              <input
                type="text"
                className="cc-input"
                value={name}
                aria-invalid={invalid !== null}
                data-runtime-name=""
                onChange={event => setTyped(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {model.duplicateOf === null ? null : (
            <p className="cc-step__line" data-duplicate-note="">
              {`A runtime named ${model.duplicateOf} already uses this setup, so no second one is added.`}
            </p>
          )}
          {invalid === null ? null : (
            <p role="alert" className="cc-step__line">
              {invalid}
            </p>
          )}
          {imports.changes.refusal === null ? null : (
            <p role="alert" className="cc-step__line" data-import-refusal="">
              {imports.changes.refusal}
            </p>
          )}
          {working ? (
            <p role="status" className="cc-step__line">
              Importing…
            </p>
          ) : null}
          <div className="cc-actions">
            <Button variant="primary" disabled={!canImport} onClick={() => void bringIn()}>
              Import
            </Button>
            <Button disabled={working} onClick={leave}>
              Skip the import
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
