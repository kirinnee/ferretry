/**
 * Settings › Secure copy › Paste rules (docs/secure-copy.md).
 *
 * A rule lets a ferret paste a value it sealed (a token it minted, say) from one place into another WITHOUT a card
 * each time: from what a program prints, or a page, into the program reading a terminal or a page's field. Every
 * paste a rule allows is still raised, audited and shown in the log, and a rule pastes unasked only where what is
 * typed is hidden. Nothing here is a value: a rule is a route, a count and an end.
 */

import {
  type CopyRouteFrom,
  type CopyRouteTo,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleSettings,
  RUNS_WHAT_IT_READS_WARNING,
  runsWhatItReads,
} from '@ferretry/protocol';
import { Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
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
  /** The owner's secure-copy settings; absent before a daemon says them. */
  readonly settings?: PasteRuleSettings;
  /** The rules whose terminal program this daemon finds only in the owner's own profile. */
  readonly profileRules?: readonly string[];
  readonly onSettings?: (settings: PasteRuleSettings) => Write;
  /** Why the setting and the badges could not be read: said in their place, never left blank. */
  readonly settingsError?: string;
}

/** What a rule into a program from the owner's profile is labelled with (docs/secure-copy.md). */
const PROFILE_RULE_BADGE = 'your profile — a ferret could swap this program';

/** What turning on programs in the owner's own profile means, said where the switch is. */
const PROFILE_TARGETS_HELP =
  'A rule can then paste into a program from your own Nix profile (~/.nix-profile), not only one the system installed. Any ferret runs as you and can change your profile, so it could swap that program for its own. Turning this on from another device asks for your passkey.';

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
  { value: 'terminal', label: 'A program in a terminal', placeholder: 'psql' },
  { value: 'browser', label: 'A field on a page', placeholder: 'https://vercel.com' },
  { value: 'secret', label: 'A secret, by name', placeholder: 'VERCEL_TOKEN' },
];

/**
 * A terminal rule matches only a program the daemon PROVES (docs/secure-copy.md): the owner should know before adding
 * one for a program installed in their own folder, which will always ask.
 */
const TERMINAL_RULE_HINT =
  'Only a program installed by the system (/usr/bin, a system profile) is proved, so only it pastes without asking. One from your own profile (~/.nix-profile) does too only if you allow programs in your own profile; one from ~/bin, or a script, always asks.';

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
          {...(toKind === 'terminal' ? { hint: TERMINAL_RULE_HINT } : {})}
        >
          {id => (
            <>
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
              {/* Right under the field, before the help line: a shell or interpreter runs whatever it reads. */}
              {toKind === 'terminal' && runsWhatItReads(to) && (
                <p
                  role="status"
                  className="m-0 flex items-start gap-1.5 text-meta font-medium text-warn"
                  data-copy-rule-runs-anything=""
                >
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {RUNS_WHAT_IT_READS_WARNING}
                </p>
              )}
            </>
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
  inProfile,
  profileAllowed,
  onRemove,
}: {
  readonly rule: PasteRule;
  readonly busy: boolean;
  readonly inProfile: boolean;
  readonly profileAllowed: boolean;
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
        {rule.to.kind === 'terminal' && runsWhatItReads(rule.to.program) && (
          <p
            className="m-0 flex items-start gap-1.5 text-meta font-medium text-warn"
            data-copy-rule-row-runs-anything=""
          >
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {RUNS_WHAT_IT_READS_WARNING}
          </p>
        )}
        {inProfile && (
          <p className="m-0 flex items-start gap-1.5 text-meta text-warn" data-copy-rule-profile="">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {PROFILE_RULE_BADGE}
              {profileAllowed ? '' : ' · asks you while profile programs are not allowed'}
            </span>
          </p>
        )}
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

/** "Paste rules may target programs in my own profile": off by default, and turning it on is a loosening. */
function ProfileTargetsSetting({
  settings,
  busy,
  onSettings,
}: {
  readonly settings: PasteRuleSettings;
  readonly busy: boolean;
  readonly onSettings: NonNullable<CopyRulesCardProps['onSettings']>;
}) {
  const id = useId();
  return (
    <div
      className="flex items-start gap-3 rounded-control border border-border bg-surface-2 p-3"
      data-copy-profile-setting=""
    >
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0"
        checked={settings.allowProfileTargets}
        disabled={busy}
        aria-describedby={`${id}-help`}
        data-copy-profile-targets=""
        onChange={event => void onSettings({ ...settings, allowProfileTargets: event.target.checked })}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-ui font-medium text-fg">
          Paste rules may target programs in my own profile
        </label>
        <p id={`${id}-help`} className="m-0 text-meta leading-base text-muted">
          {PROFILE_TARGETS_HELP}
        </p>
      </div>
    </div>
  );
}

export function CopyRulesCard({
  rules,
  busy = false,
  error = null,
  onAdd,
  onRemove,
  settings,
  profileRules = [],
  onSettings,
  settingsError,
}: CopyRulesCardProps) {
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
          Paste rules
        </h2>
      </div>
      <p className="m-0 text-cell text-muted">Pastes allowed without asking. Every paste is still logged.</p>
      {rules.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-testid="copy-rules-empty">
          No paste rules: every paste asks you.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Paste rules">
          {rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              busy={busy}
              inProfile={profileRules.includes(rule.id)}
              profileAllowed={settings?.allowProfileTargets === true}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
      {settingsError !== undefined && (
        <p role="alert" className="m-0 text-ui text-warn" data-copy-settings-error="">
          Ferretry could not check which rules a program in your own profile could satisfy, so no rule is marked:{' '}
          {settingsError}
        </p>
      )}
      {settings !== undefined && onSettings !== undefined && (
        <ProfileTargetsSetting settings={settings} busy={busy} onSettings={onSettings} />
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
