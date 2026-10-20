/**
 * Clone v2's own pieces (spec R6; build plan P9): what to copy, what the copy needs here, and how each
 * item ended. `clone.tsx` lays them out on its Preview and Done steps; the item rules and the needs
 * list are `clone-settings-model.ts`.
 *
 * THE INLINE ADD WRITES ONE WAY. A pasted value goes to THIS machine's secret store through the
 * ordinary secret route and is never shown again — the row only flips to "set ✓". Nothing here can
 * read a value back, because no route returns one.
 */

import { Check, KeyRound, Lock } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Badge, Button } from '../../../shell/primitives.tsx';
import {
  CLONE_ITEMS,
  type CloneItem,
  type CloneItemId,
  type CloneItemOutcome,
  type CloneNeed,
  needsSentence,
  outcomeSentence,
} from './clone-settings-model.ts';
import { CheckChoices, SetupNote, SetupSection } from './setup-ui.tsx';

/** The checkboxes: every item, its one-line summary from the source, and why one cannot be picked. */
export function CloneItemsChoices({
  chosen,
  summaries,
  unavailable,
  source,
  onToggle,
}: {
  readonly chosen: readonly CloneItemId[];
  readonly summaries: Readonly<Partial<Record<CloneItemId, string>>>;
  /** Items that could not be read from the source, with the reason. */
  readonly unavailable: Readonly<Partial<Record<CloneItemId, string>>>;
  readonly source: string;
  readonly onToggle: (id: CloneItemId, on: boolean) => void;
}) {
  return (
    <SetupSection title="What to copy" name="clone-items">
      <p className="m-0 text-cell leading-base text-muted">
        These are the YAML files under <span className="font-mono">$FY_HOME/config</span> on{' '}
        <span className="font-mono">{source}</span>, minus secrets. Device settings are never copied.
      </p>
      <CheckChoices
        legend="What to copy"
        legendHidden
        name="clone-items"
        values={chosen}
        onToggle={onToggle}
        options={CLONE_ITEMS.map(item => {
          const reason = unavailable[item.id];
          return {
            id: item.id,
            title: item.label,
            detail: (
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{item.detail}</span>
                {summaries[item.id] === undefined ? null : (
                  <span className="[overflow-wrap:anywhere] font-mono text-meta text-fg" data-clone-item-summary="">
                    {summaries[item.id]}
                  </span>
                )}
              </span>
            ),
            ...(reason === undefined
              ? {}
              : {
                  disabled: true,
                  extra: (
                    <span className="text-cell text-warn" data-clone-item-unavailable={item.id}>
                      {reason}
                    </span>
                  ),
                }),
          };
        })}
      />
    </SetupSection>
  );
}

/** One need: held ("set ✓"), a sign-in (done after the copy), or a field to add the secret now. */
function NeedRow({
  need,
  signIn,
  onAdd,
}: {
  readonly need: CloneNeed;
  readonly signIn?: ReactNode;
  readonly onAdd: (name: string, value: string) => Promise<string | null>;
}) {
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = (name: string): void => {
    setBusy(true);
    setProblem(null);
    void onAdd(name, value).then(failure => {
      setBusy(false);
      setProblem(failure);
      if (failure === null) setValue('');
    });
  };
  return (
    <li
      className="kt-panel flex min-w-0 flex-wrap items-center gap-2 p-panel"
      data-clone-need={need.key}
      data-held={need.held ? 'yes' : 'no'}
    >
      <span className="shrink-0 text-muted" aria-hidden="true">
        {need.kind === 'sign-in' ? <KeyRound size={14} /> : <Lock size={14} />}
      </span>
      <span className="flex min-w-0 flex-[1_1_10rem] flex-col">
        <span className="[overflow-wrap:anywhere] font-mono text-ui text-fg">needs {need.name}</span>
        <span className="[overflow-wrap:anywhere] text-meta text-muted">for {need.why}</span>
      </span>
      {need.held ? (
        <Badge tone="ok">
          <Check size={12} aria-hidden="true" /> set ✓
        </Badge>
      ) : need.kind === 'sign-in' ? (
        (signIn ?? <span className="text-meta text-muted">Sign in after copying</span>)
      ) : need.secretName === undefined ? (
        <span className="text-meta text-muted">Add it in Settings › Speed-ups</span>
      ) : (
        <span className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-2">
          <label htmlFor={fieldId} className="sr-only">
            {need.secretName}
          </label>
          <input
            id={fieldId}
            type="password"
            className="kt-input min-w-0 flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="paste value"
            data-clone-need-value={need.secretName}
            value={value}
            onChange={event => setValue(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            data-clone-need-add={need.secretName}
            disabled={busy || value.trim() === ''}
            onClick={() => add(need.secretName as string)}
          >
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </span>
      )}
      {problem === null ? null : (
        <span role="alert" className="w-full text-meta text-err">
          {problem}
        </span>
      )}
    </li>
  );
}

/**
 * "Never copied: secrets and login tokens. The copied settings need: …" — every need, with a field
 * for each secret this machine does not hold yet. Adding one now is optional: the copy works without
 * it, and whatever needs it says so until it is added.
 */
export function CloneNeedsList({
  needs,
  machineName,
  signIn,
  onAdd,
  copy,
}: {
  readonly needs: readonly CloneNeed[];
  readonly machineName: string;
  /** The sign-in action for one login, once it exists here (Done); before the copy there is none. */
  readonly signIn?: (need: CloneNeed) => ReactNode;
  /** Store one value on this machine. Resolves to a sentence on failure, `null` when stored. */
  readonly onAdd: (name: string, value: string) => Promise<string | null>;
  /** Copying secrets from the source, explicitly and by name (docs/secrets.md); absent offers none. */
  readonly copy?: ReactNode;
}) {
  const sentence = needsSentence(needs);
  return (
    <SetupSection title="Never copied: secrets and login tokens" name="clone-needs">
      {copy}
      {needs.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-clone-needs-none="">
          The copied settings need no secret and no sign-in.
        </p>
      ) : (
        <>
          <p className="m-0 text-cell leading-base text-muted">
            {sentence === null
              ? `Everything the copied settings need is already on ${machineName}.`
              : `The copied settings need: ${sentence}. Add a value now, or later: it goes into ${machineName}’s secret store and is never shown again.`}
          </p>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {needs.map(need => {
              const action = signIn?.(need);
              return (
                <NeedRow
                  key={need.key}
                  need={need}
                  onAdd={onAdd}
                  {...(action === undefined || action === null ? {} : { signIn: action })}
                />
              );
            })}
          </ul>
        </>
      )}
    </SetupSection>
  );
}

/** How each chosen item ended, with Confirm on the ones that wait for the owner. */
export function CloneOutcomes({
  outcomes,
  onConfirm,
}: {
  readonly outcomes: readonly { readonly item: CloneItem; readonly outcome: CloneItemOutcome }[];
  /** Confirm one held file: the passkey is asked by the carrier when the daemon wants it. */
  readonly onConfirm: (path: string, etag: string) => Promise<string | null>;
}) {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  return (
    <SetupSection title="What was copied" name="clone-outcomes">
      {outcomes.map(({ item, outcome }) => {
        const done = outcome.kind === 'pending' && confirmed.has(outcome.path);
        return (
          <SetupNote
            key={item.id}
            name={`clone-outcome-${item.id}`}
            tone={outcome.kind === 'refused' ? 'err' : outcome.kind === 'pending' && !done ? 'warn' : 'ok'}
          >
            <span data-clone-outcome={item.id} data-outcome={done ? 'copied' : outcome.kind}>
              {done ? outcomeSentence(item, { kind: 'copied' }) : outcomeSentence(item, outcome)}
            </span>
            {outcome.kind === 'pending' && !done ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  data-clone-confirm={outcome.path}
                  onClick={() =>
                    void onConfirm(outcome.path, outcome.etag).then(failure => {
                      if (failure === null) setConfirmed(current => new Set(current).add(outcome.path));
                      else setProblems(current => ({ ...current, [outcome.path]: failure }));
                    })
                  }
                >
                  Confirm
                </Button>
                {problems[outcome.path] === undefined ? (
                  <span className="text-meta text-muted">Or run fy config confirm on the machine.</span>
                ) : (
                  <span role="alert" className="text-meta text-err">
                    {problems[outcome.path]}
                  </span>
                )}
              </div>
            ) : null}
          </SetupNote>
        );
      })}
    </SetupSection>
  );
}
