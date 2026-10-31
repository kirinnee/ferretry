/**
 * A login's spend budget, edited (docs/budgets.md): four dollar fields — daily and weekly, a trigger
 * and a hard limit each — written as ONE key (`budget`) of the login's own file through the checked
 * configuration write, exactly as the Files panel and `fy login budget` write it. So the file's rules
 * hold unchanged: adding or lowering a limit applies at once; raising or removing one is written but
 * HELD, the tighter budget stays in effect, and it is confirmed here — with this device's passkey
 * when the daemon asks for one, which the client pool raises without this panel seeing it.
 *
 * The first budget saved from here also writes `machine.yaml`'s `timeZone`, from the zone this
 * device reports. Like any zone change it is held for the owner: a zone can move a day boundary, so a
 * first one set unconfirmed could reset a day already over budget.
 */

import { configFilePath, type FleetCredentialView } from '@ferretry/protocol';
import { useState } from 'react';
import {
  configErrorCode,
  configInvalidBody,
  confirmHeld,
  readConfigFile,
  reasonOf,
  writeConfigFile,
} from '../../config-files/config-files-api.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import {
  budgetChip,
  type BudgetDraft,
  budgetDraft,
  budgetDraftChanged,
  budgetDraftProblem,
  budgetOfDraft,
  budgetZoneWords,
} from './credentials-model.ts';
import { BudgetMeter } from './budget-meter.tsx';
import { readMachineTimeZone, withLoginBudget, withMachineTimeZone } from './login-budget-files.ts';

/** One file a save wrote but the daemon held for the owner. */
interface HeldEdit {
  readonly path: string;
  readonly etag: string;
  readonly changes: readonly string[];
}

/** What the last save came to. `pending` is a raise, a removal or a zone change, waiting for the owner. */
type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'applied' }
  | { readonly status: 'pending'; readonly held: readonly HeldEdit[] }
  | { readonly status: 'invalid'; readonly sentence: string; readonly held: readonly HeldEdit[] }
  | { readonly status: 'conflict'; readonly held: readonly HeldEdit[] }
  | { readonly status: 'failed'; readonly sentence: string; readonly held: readonly HeldEdit[] };

const IDLE: SaveState = { status: 'idle' };

/**
 * The files a save wrote and the daemon held, whatever came after: a save that wrote the zone (held) and then
 * failed on the login file still has the zone waiting, and it must stay in front of the owner here.
 */
const heldOf = (save: SaveState): readonly HeldEdit[] => ('held' in save ? save.held : []);

/** A budget write this app could never make well-formed was refused: the daemon says where. */
const refusedState = (cause: unknown, held: readonly HeldEdit[]): SaveState => {
  const invalid = configInvalidBody(cause);
  if (invalid !== undefined) return { status: 'invalid', sentence: invalid.error, held };
  const code = configErrorCode(cause);
  if (code === 'config_invalid') return { status: 'invalid', sentence: reasonOf(cause), held };
  if (code === 'config_conflict') return { status: 'conflict', held };
  return { status: 'failed', sentence: reasonOf(cause), held };
};

const CONFLICT_WORDS = 'This login’s file changed on the machine while it was being saved, so nothing was. Try again.';

const FIELD_HINT = 'Dollars, above 0. Leave a field empty for no limit; the hard limit is never below the trigger.';

/** One period's two fields. */
function BudgetPeriodFields({
  period,
  legend,
  draft,
  disabled,
  onField,
}: {
  readonly period: 'daily' | 'weekly';
  readonly legend: string;
  readonly draft: BudgetDraft;
  readonly disabled: boolean;
  readonly onField: (key: keyof BudgetDraft, value: string) => void;
}) {
  const fields: ReadonlyArray<readonly [keyof BudgetDraft, string]> =
    period === 'daily'
      ? [
          ['dailyTrigger', 'Trigger'],
          ['dailyHard', 'Hard limit'],
        ]
      : [
          ['weeklyTrigger', 'Trigger'],
          ['weeklyHard', 'Hard limit'],
        ];
  return (
    <fieldset className="m-0 flex min-w-0 flex-1 flex-col gap-1" data-budget-period={period}>
      <legend className="px-0 text-meta font-semibold uppercase text-muted">{legend}</legend>
      {fields.map(([key, label]) => (
        <label key={key} className="flex min-w-0 items-center gap-2">
          <span className="w-16 shrink-0 text-meta text-muted">{label}</span>
          <input
            className="kt-input min-w-0"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${legend} ${label}, in dollars`}
            placeholder="none"
            disabled={disabled}
            value={draft[key]}
            data-budget-input={key}
            onChange={event => onField(key, event.target.value)}
          />
        </label>
      ))}
    </fieldset>
  );
}

/** What a Confirm press came to: idle, in flight, or the sentence that says why it did not land. */
type ConfirmState = 'idle' | 'busy' | { readonly failed: string };

export function BudgetEditor({
  credential,
  machineName,
  online,
  connection,
  createClient,
  changes,
  onChanged,
  deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly credential: FleetCredentialView;
  readonly machineName: string;
  readonly online: boolean;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly changes: AccountChanges;
  /** The machine's reads are made again after a save, so the meter shows what is in effect. */
  readonly onChanged: () => unknown;
  /** Supplied in tests; the zone this device reports, written to machine.yaml on a first save. */
  readonly deviceTimeZone?: string;
}) {
  // `null` is "as the daemon last said": the draft leaves that only when a field is typed in.
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [save, setSave] = useState<SaveState>(IDLE);
  const [confirming, setConfirming] = useState<ConfirmState>('idle');
  const budget = credential.budget;
  const current = draft ?? budgetDraft(budget);
  const problem = budgetDraftProblem(current);
  const changed = budgetDraftChanged(current, budget);
  const removing = changed && budgetOfDraft(current) === undefined;
  const saving = save.status === 'saving';
  const held = budgetChip(budget);

  const setField = (key: keyof BudgetDraft, value: string): void => {
    setDraft({ ...current, [key]: value });
    setSave(IDLE);
    setConfirming('idle');
  };

  const saveBudget = async (): Promise<void> => {
    if (problem !== null || !changed || saving) return;
    changes.clear();
    setSave({ status: 'saving' });
    const held: HeldEdit[] = [];
    try {
      const client = await createClient(connection);
      // The zone every budget on this machine counts in. Written from this device when machine.yaml
      // names none, with the first budget save (docs/budgets.md); like any zone change it is held.
      const machinePath = configFilePath({ kind: 'machine' });
      const machineFile = await readConfigFile(client, machinePath);
      const zone = readMachineTimeZone(machineFile.text);
      if (zone === null) {
        setSave({ status: 'failed', sentence: 'machine.yaml does not parse; fix it in the Files panel first.', held });
        return;
      }
      if (zone === undefined) {
        const machineText = withMachineTimeZone(machineFile.text, deviceTimeZone);
        if (machineText === null) {
          setSave({
            status: 'failed',
            sentence: 'machine.yaml could not be edited; fix it in the Files panel first.',
            held,
          });
          return;
        }
        const zoneWritten = await writeConfigFile(client, machinePath, machineText, machineFile.etag);
        if (zoneWritten.outcome === 'pending') {
          held.push({
            path: machinePath,
            etag: zoneWritten.etag,
            changes: zoneWritten.pending?.changes ?? [`budgets now reset in ${deviceTimeZone}`],
          });
        }
      }
      const path = configFilePath({ kind: 'login', name: credential.id });
      const file = await readConfigFile(client, path);
      const text = withLoginBudget(file.text, budgetOfDraft(current));
      if (text === null) {
        setSave({ status: 'failed', sentence: `${path} does not parse; fix it in the Files panel first.`, held });
        return;
      }
      const written = await writeConfigFile(client, path, text, file.etag);
      if (written.outcome === 'pending') {
        held.push({
          path,
          etag: written.etag,
          changes: written.pending?.changes ?? [`${path} loosens what this login may spend`],
        });
      }
      if (held.length > 0) setSave({ status: 'pending', held });
      else {
        setSave({ status: 'applied' });
        setDraft(null);
      }
      await onChanged();
    } catch (cause) {
      setSave(refusedState(cause, held));
    }
  };

  const confirmPending = async (): Promise<void> => {
    const waiting = heldOf(save);
    if (waiting.length === 0) return;
    setConfirming('busy');
    // One confirmation per held file, in the order they were written; the first that fails stops it.
    for (const edit of waiting) {
      const sentence = await confirmHeld(createClient, connection, edit);
      if (sentence !== null) {
        setConfirming({ failed: sentence });
        return;
      }
    }
    setConfirming('idle');
    if (save.status === 'pending') {
      setSave({ status: 'applied' });
      setDraft(null);
    } else if ('held' in save) setSave({ ...save, held: [] });
    await onChanged();
  };

  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-budget-editor={credential.id}>
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Spend budget</h4>
        <p className="m-0 text-cell leading-base text-muted">
          Past its trigger nothing new starts on this login; past its hard limit its ferrets are stopped.
        </p>
        {held === null ? null : (
          <p
            role="status"
            className={
              held.tone === 'err'
                ? 'm-0 text-cell font-semibold leading-base text-err'
                : 'm-0 text-cell font-semibold leading-base text-warn'
            }
            data-budget-held=""
          >
            {held.label}
          </p>
        )}
        {budget === undefined ? null : <BudgetMeter budget={budget} machineName={machineName} />}
      </div>

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
        <BudgetPeriodFields period="daily" legend="Daily" draft={current} disabled={saving} onField={setField} />
        <BudgetPeriodFields period="weekly" legend="Weekly" draft={current} disabled={saving} onField={setField} />
      </div>

      <p className="m-0 text-meta leading-base text-muted" data-budget-hint="">
        {FIELD_HINT}
      </p>
      {problem === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-budget-problem="">
          {problem}
        </p>
      )}
      <p className="m-0 text-meta leading-base text-muted" data-budget-zone="">
        {budgetZoneWords(budget, deviceTimeZone)}
      </p>

      {save.status === 'invalid' ? (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-budget-save="invalid">
          {save.sentence}
        </p>
      ) : null}
      {save.status === 'conflict' ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn" data-budget-save="conflict">
          {CONFLICT_WORDS}
        </p>
      ) : null}
      {save.status === 'failed' ? (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-budget-save="failed">
          {save.held.length === 0 ? 'Nothing was saved.' : 'The budget was not saved.'} {save.sentence}
        </p>
      ) : null}
      {save.status === 'applied' ? (
        <p role="status" className="m-0 text-ui font-semibold leading-base text-ok" data-budget-save="applied">
          In effect
        </p>
      ) : null}
      {heldOf(save).length > 0 ? (
        <div
          role="status"
          className="flex min-w-0 flex-col gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2"
          data-budget-save="pending"
        >
          <span className="text-ui leading-base text-fg">
            {save.status === 'pending' ? 'Saved' : 'Written'} — waiting for your confirmation:{' '}
            {heldOf(save)
              .flatMap(edit => edit.changes)
              .join('; ')}
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px]"
              data-budget-confirm=""
              disabled={confirming === 'busy'}
              onClick={() => void confirmPending()}
            >
              {confirming === 'busy' ? 'Confirming…' : 'Confirm'}
            </Button>
            {typeof confirming === 'object' ? (
              <span
                role="alert"
                className="min-w-0 break-words text-cell leading-base text-err"
                data-budget-confirm-failed=""
              >
                {confirming.failed}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {save.status === 'pending' ? null : changed ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy || saving}
          busyLabel="Saving…"
          refusal={changes.refusal}
          submitLabel={removing ? 'Remove budget' : 'Save budget'}
          disabled={!online || problem !== null}
          onSubmit={() => void saveBudget()}
        >
          <Button
            type="button"
            data-budget-undo=""
            onClick={() => {
              changes.clear();
              setDraft(null);
              setSave(IDLE);
              setConfirming('idle');
            }}
          >
            Undo
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </section>
  );
}
