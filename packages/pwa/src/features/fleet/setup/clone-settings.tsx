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
import { CLONE_KEEP_DEFAULT, CLONE_NO_DEFAULT, type CloneDefaultView } from './clone-model.ts';
import {
  CLONE_ITEMS,
  type CloneItemId,
  type CloneItemOutcome,
  type CloneLogin,
  type CloneNeed,
  type CloneOutcomeItem,
  needsSentence,
  outcomeSentence,
} from './clone-settings-model.ts';
import { CheckChoices, SetupNote, SetupRow, SetupSection } from './setup-ui.tsx';
import { countWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

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

/** The row's verdict in words, above its reason: the status mark alone is only spoken. */
function LoginDetail({ word, tone, text }: { readonly word: string; readonly tone: string; readonly text: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={`text-cell font-semibold ${tone}`}>{word}</span>
      <span>{text}</span>
    </span>
  );
}

/**
 * The logins the copy brings, split by what the owner decided (docs/secrets.md): an API-key login copies
 * and its keys follow SEALED, for one passkey on the source, so the runtime works on arrival; a Claude
 * Code or Codex sign-in does not copy, and says to sign in on this machine.
 */
export function CloneLoginsSection({
  logins,
  machineName,
  sourceName,
  keys,
  copyKeys,
  onCopyKeys,
}: {
  readonly logins: readonly CloneLogin[];
  readonly machineName: string;
  readonly sourceName: string;
  /** The keys that would be sealed and sent: names only. Empty when there is nothing to send. */
  readonly keys: readonly string[];
  readonly copyKeys: boolean;
  readonly onCopyKeys: (on: boolean) => void;
}) {
  const boxId = useId();
  if (logins.length === 0 && keys.length === 0) return null;
  const sending = copyKeys && keys.length > 0;
  return (
    <SetupSection title="Logins and keys" name="clone-logins">
      {logins.map(login =>
        login.kind === 'api-key' ? (
          <SetupRow
            key={login.id}
            name={`login-${login.id}`}
            status="ready"
            title={<span className="font-mono">{login.name}</span>}
            detail={
              <LoginDetail
                word={
                  login.keys.length === 0
                    ? 'Copies'
                    : login.keys.every(key => key.held)
                      ? 'Key already here'
                      : sending && login.keys.some(key => keys.includes(key.name))
                        ? 'Copies with its key'
                        : 'Copies, add its key'
                }
                tone="text-ok"
                text={
                  login.keys.length === 0
                    ? `${SETUP_HARNESS_NAMES[login.harness]} · API-key login with no secret to send`
                    : `${SETUP_HARNESS_NAMES[login.harness]} · API key ${login.keys
                        .map(key => (key.held ? `${key.name} (already on ${machineName})` : key.name))
                        .join(', ')}`
                }
              />
            }
          />
        ) : (
          <SetupRow
            key={login.id}
            name={`login-${login.id}`}
            status="needs_sign_in"
            title={`${SETUP_HARNESS_NAMES[login.harness]} · ${login.name}`}
            detail={
              <LoginDetail
                word={`Sign in on ${machineName}`}
                tone="text-warn"
                text="Never copied: a refresh token on two machines would sign one of them out. It arrives as an empty slot, with a Sign in button once the copy is done."
              />
            }
          />
        ),
      )}
      {keys.length === 0 ? null : (
        <label
          htmlFor={boxId}
          className="kt-panel relative flex min-h-control min-w-0 cursor-pointer items-start gap-3 p-panel has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus"
          data-clone-keys=""
        >
          <input
            id={boxId}
            type="checkbox"
            className="mt-1 shrink-0 accent-[var(--accent)]"
            checked={copyKeys}
            onChange={event => onCopyKeys(event.currentTarget.checked)}
            data-clone-keys-copy=""
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-row font-semibold text-fg">
              Copy {countWords(keys.length, 'API key')} with the logins
            </span>
            <span className="[overflow-wrap:anywhere] font-mono text-meta text-fg" data-clone-keys-names="">
              {keys.join(', ')}
            </span>
            <span className="text-cell text-muted">
              {copyKeys
                ? `${sourceName} seals them for ${machineName} and asks for your passkey once. This browser carries them and can’t read them.`
                : `Not copied: add each one on ${machineName} yourself, below.`}
            </span>
          </span>
        </label>
      )}
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
    <SetupSection title="Secrets and sign-ins this setup needs" name="clone-needs">
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
  readonly outcomes: readonly { readonly item: CloneOutcomeItem; readonly outcome: CloneItemOutcome }[];
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

/**
 * "Default runtime for new agents" on the Preview: the one the copy would leave this machine with, as a
 * choice the person can change before copying. Replace removes this machine's runtimes, so the default
 * has to be one the copy brings; saying so here is what keeps it from being a surprise.
 */
export function DefaultRuntimeChoice({
  view,
  onPick,
}: {
  readonly view: CloneDefaultView;
  readonly onPick: (value: string) => void;
}) {
  const id = useId();
  return (
    <SetupSection title="Default runtime for new agents" name="default-runtime">
      <label className="sr-only" htmlFor={id}>
        Default runtime for new agents
      </label>
      <select
        aria-describedby={`${id}-hint`}
        className="kt-input w-full"
        data-clone-default-runtime=""
        id={id}
        onChange={event => onPick(event.target.value)}
        value={view.selected}
      >
        {view.canKeep ? <option value={CLONE_KEEP_DEFAULT}>Keep what it has now</option> : null}
        {view.candidates.map(candidate => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.name} ({SETUP_HARNESS_NAMES[candidate.harness]})
          </option>
        ))}
        <option value={CLONE_NO_DEFAULT}>None (automatic)</option>
      </select>
      <p className="m-0 text-meta leading-base text-muted" data-clone-default-runtime-hint="" id={`${id}-hint`}>
        {view.sentence}
      </p>
    </SetupSection>
  );
}
