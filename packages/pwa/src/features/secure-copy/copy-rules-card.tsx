/**
 * Settings › Secure copy › Pastes approved in advance (docs/secure-copy.md).
 *
 * A rule lets a ferret paste a value it sealed (a token it minted, say) from one place into another WITHOUT a card
 * each time: from what a program prints, or a page, into the program reading a terminal or a page's field. Every
 * paste a rule allows is still raised, audited and shown in the log, and a rule pastes unasked only where what is
 * typed is hidden. Nothing here is a value: a rule is a route, a count and an end.
 */

import type { CopyRouteFrom, CopyRouteTo, PasteRule, PasteRuleCreate } from '@ferretry/protocol';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { fromWords, ruleFromForm, ruleLimits, toWords } from '../../lib/secure-copy.ts';

/** A write reports whether it took, so the form clears only when the daemon accepted it. */
type Write = Promise<boolean> | boolean;

export interface CopyRulesCardProps {
  readonly rules: readonly PasteRule[];
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onAdd: (rule: PasteRuleCreate) => Write;
  readonly onRemove: (id: string) => Write;
}

const INPUT = 'kt-input min-h-[44px] w-full rounded-control border border-border bg-surface-2 px-2 text-fg';

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-cell font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {hint !== undefined && <p className="m-0 text-meta leading-base text-faint">{hint}</p>}
    </div>
  );
}

const FROM_KINDS: readonly {
  readonly value: CopyRouteFrom['kind'];
  readonly label: string;
  readonly placeholder: string;
}[] = [
  { value: 'command', label: 'What a program prints', placeholder: 'gh' },
  { value: 'browser', label: 'Text on a page', placeholder: 'https://github.com' },
  { value: 'clipboard', label: 'A page’s clipboard', placeholder: 'https://github.com' },
];

const TO_KINDS: readonly {
  readonly value: CopyRouteTo['kind'];
  readonly label: string;
  readonly placeholder: string;
}[] = [
  { value: 'terminal', label: 'A program in a terminal', placeholder: 'vercel' },
  { value: 'browser', label: 'A field on a page', placeholder: 'https://vercel.com' },
  { value: 'secret', label: 'A secret, by name', placeholder: 'VERCEL_TOKEN' },
];

function AddRuleForm({
  busy,
  onAdd,
  onClose,
}: {
  readonly busy: boolean;
  readonly onAdd: CopyRulesCardProps['onAdd'];
  readonly onClose: () => void;
}) {
  const [fromKind, setFromKind] = useState<CopyRouteFrom['kind']>('command');
  const [from, setFrom] = useState('');
  const [toKind, setToKind] = useState<CopyRouteTo['kind']>('terminal');
  const [to, setTo] = useState('');
  const [count, setCount] = useState('1');
  const [hours, setHours] = useState('24');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const built = ruleFromForm({ fromKind, from, toKind, to, count, hours });
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setProblem(undefined);
    if (await onAdd(built.rule)) onClose();
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-control border border-border-strong bg-surface-2 p-3"
      data-copy-rule-form=""
      onSubmit={event => void submit(event)}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="From">
          {id => (
            <select
              id={id}
              className={INPUT}
              value={fromKind}
              data-copy-rule-from-kind=""
              onChange={event => setFromKind(event.target.value as CopyRouteFrom['kind'])}
            >
              {FROM_KINDS.map(kind => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={fromKind === 'command' ? 'Program' : 'Page origin'}>
          {id => (
            <input
              id={id}
              className={`${INPUT} mono`}
              value={from}
              placeholder={FROM_KINDS.find(kind => kind.value === fromKind)?.placeholder}
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              data-copy-rule-from=""
              onChange={event => setFrom(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="Into">
          {id => (
            <select
              id={id}
              className={INPUT}
              value={toKind}
              data-copy-rule-to-kind=""
              onChange={event => setToKind(event.target.value as CopyRouteTo['kind'])}
            >
              {TO_KINDS.map(kind => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label={toKind === 'terminal' ? 'Program reading it' : toKind === 'secret' ? 'Secret name' : 'Page origin'}
        >
          {id => (
            <input
              id={id}
              className={`${INPUT} mono`}
              value={to}
              placeholder={TO_KINDS.find(kind => kind.value === toKind)?.placeholder}
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              data-copy-rule-to=""
              onChange={event => setTo(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Field label="Pastes it allows" hint="Empty for no count.">
          {id => (
            <input
              id={id}
              className={INPUT}
              inputMode="numeric"
              value={count}
              data-copy-rule-count=""
              onChange={event => setCount(event.target.value)}
            />
          )}
        </Field>
        <Field label="Lasts (hours)" hint="Empty for no end; 720 at most.">
          {id => (
            <input
              id={id}
              className={INPUT}
              inputMode="decimal"
              value={hours}
              data-copy-rule-hours=""
              onChange={event => setHours(event.target.value)}
            />
          )}
        </Field>
      </div>
      {problem !== undefined && (
        <p role="alert" className="m-0 text-meta text-err" data-copy-rule-problem="">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="kt-btn min-h-[44px]" data-variant="primary" disabled={busy}>
          <Plus size={14} aria-hidden="true" /> {busy ? 'Saving…' : 'Approve this route'}
        </button>
        <button type="button" className="kt-btn min-h-[44px]" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RuleRow({
  rule,
  busy,
  onRemove,
}: {
  readonly rule: PasteRule;
  readonly busy: boolean;
  readonly onRemove: CopyRulesCardProps['onRemove'];
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-copy-rule={rule.id}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0">
          <span className="min-w-0 break-words text-ui text-fg" data-copy-route="">
            {fromWords(rule.from)}
            {'\u00a0→ '}
            <span className="font-medium">{toWords(rule.to)}</span>
          </span>
        </p>
        <p className="m-0 text-meta text-faint" data-copy-rule-limits="">
          {ruleLimits(rule)}
          {rule.plan === undefined ? '' : ' · from a ferret’s plan'}
        </p>
      </div>
      <button
        type="button"
        className="kt-btn min-h-[44px]"
        disabled={busy}
        aria-label={`Remove the rule ${fromWords(rule.from)} into ${toWords(rule.to)}`}
        onClick={() => void onRemove(rule.id)}
      >
        <Trash2 size={14} aria-hidden="true" /> Remove
      </button>
    </li>
  );
}

export function CopyRulesCard({ rules, busy = false, error = null, onAdd, onRemove }: CopyRulesCardProps) {
  const [adding, setAdding] = useState(false);
  return (
    <section
      className="kt-panel flex flex-col gap-3 p-panel"
      aria-labelledby="copy-rules-heading"
      data-testid="copy-rules-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="copy-rules-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
          Pastes approved in advance
        </h2>
      </div>
      <p className="m-0 text-cell text-muted">Pastes allowed without asking. Every paste is still logged.</p>
      {rules.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-testid="copy-rules-empty">
          No pastes are approved in advance: every paste asks you.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Pastes approved in advance">
          {rules.map(rule => (
            <RuleRow key={rule.id} rule={rule} busy={busy} onRemove={onRemove} />
          ))}
        </ul>
      )}
      {error !== null && (
        <p role="alert" className="m-0 text-ui text-err" data-testid="copy-rules-error">
          {error}
        </p>
      )}
      {adding ? (
        <AddRuleForm busy={busy} onAdd={onAdd} onClose={() => setAdding(false)} />
      ) : (
        <div>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-copy-rule-add-open=""
            onClick={() => setAdding(true)}
          >
            <Plus size={14} aria-hidden="true" /> Approve a route
          </button>
        </div>
      )}
    </section>
  );
}
