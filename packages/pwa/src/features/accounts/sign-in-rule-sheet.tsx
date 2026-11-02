/**
 * The owner's sheet for a STANDING SIGN-IN RULE (docs/secure-copy.md, "Sign-in rules"): what Ferretry may type for one
 * account, at one place, for any ferret, until a time. The owner ticks it and approves it with a passkey bound to the
 * exact bytes the daemon stages; nothing here is a value. Every warning is drawn from a STRUCTURED fact (the place's
 * kind, the code tick, the recipe flag), never from summary text, which may be clipped. When a ferret's suggestion
 * opened the sheet NOTHING is ticked, and the code needs its own red acknowledgement.
 */

import type {
  Place,
  SignInRuleEligibility,
  SignInRuleScope,
  SignInRuleSurface,
  SignInRuleView,
} from '@ferretry/protocol';
import { Fragment, useId, useState } from 'react';
import {
  daysWords,
  defaultDays,
  INELIGIBLE_WORDS,
  initialRuleTicks,
  lifetimeDaysOptions,
  RULE_DISMISSED_WORDS,
  RULE_NO_PASSKEY_DEVICE_WORDS,
  RULE_STILL_ASKED,
  RULE_TOTP_ACK_WORDS,
  type RuleOrigin,
  type RuleProgress,
  type RuleTicks,
  ruleFlags,
  scopeWords,
  ruleWordsOf,
  sheetWords,
  statusWords,
  surfaceOf,
  ticksProblem,
} from '../../lib/sign-in-rules.ts';
import { SignInRuleWords } from './sign-in-rule-words.tsx';

export type RuleSheetPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: RuleProgress }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

export interface SignInRuleSheetProps {
  /** The account's name, from a secrets-gated route. */
  readonly accountName: string;
  readonly username?: string;
  readonly place: Place;
  readonly origin: RuleOrigin;
  /** The rule being resumed or renewed. */
  readonly before?: SignInRuleView;
  /**
   * The sign-in's rule an approval opened from elsewhere (a ferret's suggestion, the post-tap offer) replaces: the
   * sign-in has one already, so approving here renews, resumes or changes it. Its terms are shown.
   */
  readonly replacing?: SignInRuleView;
  /** `undefined` while the daemon is asked. */
  readonly eligibility: SignInRuleEligibility | undefined;
  /** Whether the account has a 2FA key Ferretry makes codes for. */
  readonly codeAvailable: boolean;
  /** The label of the 2FA key a ticked code would use (the one the daemon pins). */
  readonly codeKey?: string | undefined;
  /** Whether the sign-in applies its recipe by itself (a structured fact the daemon reports). */
  readonly autoRecipe: boolean;
  /** Where the rule may apply, "any ferret" first. */
  readonly scopes: readonly SignInRuleScope[];
  readonly canUsePasskey: boolean;
  readonly phase: RuleSheetPhase;
  readonly onApprove: (ticks: RuleTicks) => void;
  readonly onCancel: () => void;
}

const PROGRESS_WORDS: Readonly<Record<RuleProgress, string>> = {
  staging: 'Preparing what you ticked…',
  passkey: 'Waiting for your passkey…',
  committing: 'Approving…',
};

const ANY_SCOPE: SignInRuleScope = { kind: 'any' };

const scopeKey = (scope: SignInRuleScope): string =>
  scope.kind === 'any' ? 'any' : scope.kind === 'project' ? `project:${scope.project}` : `session:${scope.session}`;

/** What a rule can't cover, said on every sheet. */
export function RuleStillAsked() {
  return (
    <details className="text-meta text-muted" data-rule-still-asked="">
      <summary className="min-h-[44px] cursor-pointer py-3 text-meta font-medium text-muted">
        You’ll still be asked
      </summary>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-meta text-muted">
        {RULE_STILL_ASKED.map(each => (
          <li className="min-w-0 break-words" key={each.what}>
            {each.what}: {each.instead}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Tick({
  id,
  checked,
  disabled,
  onChange,
  tone = 'fg',
  tickName,
  children,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (on: boolean) => void;
  readonly tone?: 'fg' | 'err';
  readonly tickName: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label
      className={`flex min-h-[44px] cursor-pointer items-start gap-3 text-ui ${tone === 'err' ? 'text-err' : 'text-fg'}`}
      htmlFor={id}
    >
      <input
        checked={checked}
        className="mt-0.5 h-5 w-5 shrink-0"
        data-rule-tick={tickName}
        disabled={disabled}
        id={id}
        onChange={event => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span className="flex min-w-0 flex-col gap-1">{children}</span>
    </label>
  );
}

/** What approving here does to the sign-in's rule: never a second one. */
const replacingWords = (rule: SignInRuleView): string =>
  `This sign-in already has a standing rule (${statusWords(rule)}). Approving here replaces it. It allows now:`;

/** The rows of the replaced rule the owner compares the new ticks with. */
const REPLACED_ROWS: ReadonlySet<string> = new Set(['Types', 'Who', 'Until', 'Uses']);

export function SignInRuleSheet(props: SignInRuleSheetProps) {
  const { accountName, username, place, origin, before, eligibility, phase, canUsePasskey } = props;
  const surface: SignInRuleSurface = surfaceOf(place);
  const id = useId();
  const [ticks, setTicks] = useState<RuleTicks>(() =>
    initialRuleTicks({ surface, origin, hasUsername: username !== undefined, before }),
  );
  const working = phase.kind === 'working';
  const problem = ticksProblem(ticks, surface);
  const blocked = !canUsePasskey;
  const ineligible = eligibility?.eligible === false ? eligibility.because : undefined;
  const times = eligibility?.eligible === true ? eligibility.history : undefined;
  const history =
    times === undefined || times < 1
      ? undefined
      : `You signed in here yourself ${String(times)} ${times === 1 ? 'time' : 'times'}.`;
  const set = (change: Partial<RuleTicks>): void => setTicks(current => ({ ...current, ...change }));
  const scopes = props.scopes.some(scope => scope.kind === 'any') ? props.scopes : [ANY_SCOPE, ...props.scopes];

  const heading =
    origin === 'resume'
      ? 'Resume the standing rule'
      : origin === 'renew'
        ? 'Approve it again'
        : origin === 'widen'
          ? 'Change the standing rule'
          : 'Don’t ask again';

  return (
    <div className="flex min-w-0 flex-col gap-3" data-rule-sheet={surface} data-rule-origin={origin}>
      <h3 className="m-0 text-ui font-semibold text-fg">{heading}</h3>
      <SignInRuleWords
        {...sheetWords({
          accountName,
          username,
          place,
          ticks,
          codeKey: props.codeKey,
        })}
        flags={ruleFlags({ root: surface === 'terminal', totp: ticks.totp, autoRecipe: props.autoRecipe })}
        note={history}
      />

      {props.replacing === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1" data-rule-replaces={props.replacing.status}>
          <p className="m-0 text-ui text-muted" role="status">
            {replacingWords(props.replacing)}
          </p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 text-cell text-muted" data-rule-replaces-rows="">
            {ruleWordsOf(props.replacing)
              .rows.filter(row => REPLACED_ROWS.has(row.label))
              .map(row => (
                <Fragment key={row.label}>
                  <dt className="m-0">{row.label}</dt>
                  <dd className="m-0 min-w-0 break-words">{row.value}</dd>
                </Fragment>
              ))}
          </dl>
        </div>
      )}
      {eligibility === undefined ? (
        <p className="m-0 text-ui text-muted" data-rule-eligibility="reading" role="status">
          Checking whether this sign-in can have a rule…
        </p>
      ) : null}
      {ineligible === undefined ? null : (
        <p className="m-0 text-ui text-warn" data-rule-ineligible={ineligible} role="status">
          {INELIGIBLE_WORDS[ineligible]}.
        </p>
      )}

      {eligibility?.eligible === true ? (
        <>
          <p className="m-0 text-cell text-muted">
            {origin === 'suggestion'
              ? 'A ferret suggested this. Nothing is ticked: choose what Ferretry may type.'
              : 'Tick what Ferretry may type for any ferret, without asking.'}
          </p>
          <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" data-rule-fields="">
            <legend className="sr-only">What Ferretry may type</legend>
            {surface === 'page' && username !== undefined ? (
              <Tick
                checked={ticks.username}
                disabled={working}
                id={`${id}-user`}
                onChange={on => set({ username: on })}
                tickName="username"
              >
                <span>Username</span>
              </Tick>
            ) : null}
            <Tick
              checked={ticks.password}
              disabled={working}
              id={`${id}-pass`}
              onChange={on => set(on ? { password: true } : { password: false, totp: false, totpAcknowledged: false })}
              tickName="password"
            >
              <span>Password</span>
            </Tick>
            {surface === 'page' && props.codeAvailable ? (
              <Tick
                checked={ticks.totp}
                disabled={working || !ticks.password}
                id={`${id}-code`}
                onChange={on => set({ totp: on, totpAcknowledged: false })}
                tickName="totp"
                tone="err"
              >
                <span className="text-fg">Also fill the 2FA code</span>
              </Tick>
            ) : null}
            {ticks.totp ? (
              <Tick
                checked={ticks.totpAcknowledged}
                disabled={working}
                id={`${id}-ack`}
                onChange={on => set({ totpAcknowledged: on })}
                tickName="totp-ack"
                tone="err"
              >
                <span>{RULE_TOTP_ACK_WORDS}</span>
              </Tick>
            ) : null}
          </fieldset>

          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-days`}>
            How long
            <select
              className="kt-input min-h-[44px] min-w-0"
              data-rule-days=""
              disabled={working}
              id={`${id}-days`}
              onChange={event => set({ days: Number(event.currentTarget.value) })}
              value={ticks.days}
            >
              {lifetimeDaysOptions(surface).map(days => (
                <option key={days} value={days}>
                  {daysWords(days)}
                  {days === defaultDays(surface) ? ' (usual)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-uses`}>
            Most uses (leave empty for no limit)
            <input
              className="kt-input min-h-[44px] min-w-0"
              data-rule-uses=""
              disabled={working}
              id={`${id}-uses`}
              inputMode="numeric"
              max={1000}
              min={1}
              onChange={event => {
                const text = event.currentTarget.value.trim();
                set({ uses: text === '' ? undefined : Number(text) });
              }}
              type="number"
              value={ticks.uses ?? ''}
            />
          </label>

          {scopes.length > 1 ? (
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-scope`}>
              Who may use it
              <select
                className="kt-input min-h-[44px] min-w-0"
                data-rule-scope=""
                disabled={working}
                id={`${id}-scope`}
                onChange={event => {
                  const next = scopes.find(scope => scopeKey(scope) === event.currentTarget.value);
                  if (next !== undefined) set({ scope: next });
                }}
                value={scopeKey(ticks.scope)}
              >
                {scopes.map(scope => (
                  <option key={scopeKey(scope)} value={scopeKey(scope)}>
                    {scopeWords(scope)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <RuleStillAsked />
        </>
      ) : null}

      {phase.kind === 'working' ? (
        <p className="m-0 text-ui text-muted" data-rule-progress={phase.progress} role="status">
          {PROGRESS_WORDS[phase.progress]}
        </p>
      ) : null}
      {phase.kind === 'dismissed' ? (
        <p className="m-0 text-ui text-warn" data-rule-dismissed="" role="status">
          {RULE_DISMISSED_WORDS}
        </p>
      ) : null}
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-rule-failure="" role="alert">
          {phase.words}
        </p>
      ) : null}
      {blocked ? (
        <p className="m-0 text-meta text-warn" data-rule-no-passkey="" role="status">
          {RULE_NO_PASSKEY_DEVICE_WORDS}
        </p>
      ) : null}
      {problem !== undefined && eligibility?.eligible === true ? (
        <p className="m-0 text-meta text-muted" data-rule-problem="" role="status">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2" data-rule-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-rule-cancel=""
          disabled={working}
          onClick={props.onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-rule-approve=""
          data-variant="primary"
          disabled={working || eligibility?.eligible !== true || problem !== undefined || blocked}
          onClick={() => props.onApprove(ticks)}
          type="button"
        >
          {working ? 'Approving…' : 'Approve with passkey'}
        </button>
      </div>
    </div>
  );
}
