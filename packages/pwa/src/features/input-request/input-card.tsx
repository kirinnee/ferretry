/**
 * THE INPUT CARD — an agent is stuck at a password, `sudo`, one-time-code or 2FA prompt and only the owner knows
 * the value (docs/input-requests.md, "The agenda card").
 *
 * WHAT THE CARD SHOWS, top to bottom: who needs what and where, what the DAEMON saw at that target (drawn
 * large: the program, whether typing is hidden, the prompt line), the ferret's own words small (they are
 * a claim, not evidence), the risk flag, then the way in:
 *
 *   - a saved login the daemon matched to this target is ONE TAP: "Use saved <label>". Tapping it is the owner's
 *     permission; nothing is ever sent on its own. Only a `matched` offer is that button, never a hinted one;
 *   - otherwise (or after "Type a different one") one masked field per value, each with a local eye that is not
 *     remembered, "Press Enter for me", and "Save as" when the value is ever kept (one value, or a login
 *     card's username and password kept together);
 *   - the other saved logins stay selectable by hand under "Choose another account".
 *
 * A CARD OF SEVERAL FIELDS (a login's email and password) is ONE Send: it waits until every field is typed, and
 * each PLAIN field carries its own red flag, because the ferret can see that value. A saved login is one tap for
 * the whole card.
 *
 * THE VALUES LIVE ONLY IN THE CONTROLLED FIELDS until Send. They are never put in a draft store, storage, a query
 * cache, a URL or a log; every field is cleared on Send, when the card unmounts and when the page is hidden. A saved
 * value NEVER passes through this app: tapping a login sends its handle and the daemon types it.
 */

import {
  type AccountList,
  grantFilledLineFor,
  grantMissLineFor,
  INPUT_LOCK_WORDS,
  type InputRequest,
  type InputSavedOffer,
  type InputShot,
  lockWords,
  pickOneWords,
  type SignInSummary,
  strongestSensitivity,
  type TwoFactorId,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { Eye, EyeOff, Shield, ShieldAlert, ShieldCheck, ShieldQuestion, Timer } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';
import { SignInRuleOffer } from '../secure-copy/sign-in-rule-offer.tsx';
import { codesAccounts, startingAccount } from '../../lib/automatic-codes.ts';
import { cancelInput, deliverInput, type InputClient, putAccountDefault, readInputShot } from '../../lib/input-api.ts';
import {
  type AlwaysUse,
  accountTitleWords,
  alwaysUseFor,
  cardAccountWords,
  cardOffersSave,
  cardSaveBlock,
  chainWords,
  choiceReasonWords,
  codeButtonWords,
  codeCheckedWords,
  codeTitleWords,
  defaultSubmit,
  differentAccountWords,
  expiryWords,
  fieldAttributes,
  fieldProblem,
  fieldRiskLine,
  type InputCardField,
  initialSaveDraft,
  inputFailure,
  normalizeHandle,
  observedWords,
  offersPressEnter,
  oneFactorLine,
  offerUsername,
  pastedWords,
  pickOneOffers,
  plainFlagWords,
  revealable,
  saveDraftProblem,
  savesUsername,
  editSaveLabel,
  editSaveUsername,
  updateChoiceWords,
  usernameLocked,
  savedBody,
  savedButtonWords,
  savedOutcomeWords,
  sealedBody,
  sendBlock,
  shotBoxes,
  showsHeaderRisk,
  signInWords,
  splitOffers,
  switchSaveMode,
  targetRef,
  titleWords,
  typedBody,
  typedFieldsBody,
  typedReady,
  updatedEntry,
  updateWords,
} from '../../lib/input-card.ts';
import { pasteRoute } from '../../lib/secure-copy.ts';
import { AutomaticCodesPanel } from './automatic-codes.tsx';

export interface InputCardProps {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly client: InputClient;
  /** Who is asking, as the page names the ferret. */
  readonly agentName?: string;
  /** Fixed clock for the countdown (the harness and tests); absent: the real one, ticking. */
  readonly now?: number;
  /** The request is settled (sent or cancelled): the host re-reads. */
  readonly onDone: () => void;
  /** The daemon says the facts moved: the host reads the request again. */
  readonly onRefresh?: () => void;
  /**
   * Drawn inside an agenda item (the v5 item view or the compact card), which already has the title, the type
   * badge and the frame: the card then draws no panel and no heading of its own, only the target and the clock.
   */
  readonly embedded?: boolean;
  /**
   * The owner's accounts, read only from a daemon that reports 2FA keys. With them a code card is titled from the
   * account's keys and offers "Set up automatic codes"; without them it is the plain card it always was.
   */
  readonly accounts?: AccountList;
  /** Asks for the passkey that saves a staged key (bound to that stage); absent: the setup panel is not offered. */
  readonly addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
  /** Present only when the machine offers standing sign-in rules: after a hand-tapped sign-in, the card offers to make one. */
  readonly ruleOffer?: { readonly askPasskey: RulesBinding['askPasskey'] };
}

const RISK_ICON = { green: ShieldCheck, neutral: Shield, amber: ShieldQuestion, red: ShieldAlert } as const;
const RISK_TONE = { green: 'text-ok', neutral: 'text-muted', amber: 'text-warn', red: 'text-err' } as const;

/** Where a pre-approval filled the card, for its line: the page's host as the daemon saw it, or nothing. */
const filledPlace = (request: InputRequest): string | undefined => {
  if (request.observed?.kind !== 'browser') return undefined;
  try {
    return new URL(request.observed.origin).host.toLowerCase();
  } catch {
    return undefined;
  }
};

const useNow = (fixed: number | undefined): number => {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
};

export function InputCard({
  request,
  fields,
  client,
  agentName = 'The ferret',
  now: fixedNow,
  onDone,
  onRefresh,
  embedded = false,
  accounts,
  addKey,
  ruleOffer,
}: InputCardProps) {
  const headingId = useId();
  const now = useNow(fixedNow);
  const [settled, setSettled] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [always, setAlways] = useState<AlwaysUse | undefined>(undefined);
  const [tappedSignIn, setTappedSignIn] = useState<SignInSummary['id'] | undefined>(undefined);
  const facts = observedWords(request);
  const blocked = sendBlock(request, now);
  // Why the task plan (or a standing rule) did not fill this card: the owner's view only, one fixed sentence by source,
  // and none for `not-here`.
  const planMissLine = request.preapproval === undefined ? undefined : grantMissLineFor(request.preapproval);
  // One sentence with the daemon's agenda history line, with the page's host when the card knows it (C9).
  const planFilledLine =
    request.preapproval?.outcome === 'filled'
      ? grantFilledLineFor(request.preapproval, filledPlace(request))
      : undefined;
  // The FIELDS decide, never the card's own word: a field the daemon upgraded to a secret gets no code title and no panel.
  const asksCode = strongestSensitivity(request.fields) === 'code';
  const codeAccounts = asksCode && accounts !== undefined ? codesAccounts(request.saved, accounts) : [];
  const startAt = startingAccount(request.saved, codeAccounts);
  const codeFor = accounts?.accounts.find(each => each.id === startAt?.id);
  // Whose sign-in this is, named ONLY from the secrets-gated accounts listing (`accounts`): a device that may not read
  // accounts, and the agenda text every reader sees, say the place only (secrev-1261 L4).
  const forAccount = asksCode ? undefined : cardAccountWords(request.saved, accounts);
  const title =
    asksCode && codeFor !== undefined
      ? codeTitleWords(request, agentName, codeFor)
      : forAccount !== undefined
        ? accountTitleWords(request, agentName, forAccount)
        : titleWords(request, agentName);
  const setup =
    addKey !== undefined && codeAccounts.length > 0 && request.state === 'pending' ? (
      <AutomaticCodesPanel
        accounts={codeAccounts}
        addKey={addKey}
        client={client}
        initial={startAt}
        onSaved={() => onRefresh?.()}
        requestId={request.id}
      />
    ) : null;
  const Risk = request.risk === undefined ? null : RISK_ICON[request.risk.level];

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setProblem(null);
    try {
      await cancelInput(client, request);
      setSettled('Cancelled. Nothing was typed.');
      onDone();
    } catch (cause) {
      setProblem(inputFailure(cause, request.target.kind).text);
    } finally {
      setCancelling(false);
    }
  };

  const cancelButton = (
    <button
      className="kt-btn min-h-[44px]"
      data-input-cancel=""
      disabled={cancelling}
      onClick={() => void cancel()}
      type="button"
    >
      Cancel request
    </button>
  );
  const target = (
    <p className="m-0 text-cell text-muted">
      Goes to{' '}
      <code className="mono text-fg" data-input-target="">
        {targetRef(request)}
      </code>
    </p>
  );
  const expiry = (
    <span className="ml-auto whitespace-nowrap text-meta text-faint" data-input-expiry="">
      {expiryWords(request.expiresAt, now)}
    </span>
  );
  const chainLine = chainWords(request);
  const chain =
    chainLine === undefined ? null : (
      <p className="m-0 text-meta font-medium text-muted" data-input-chain="">
        {chainLine}
      </p>
    );

  return (
    <section
      {...(embedded ? { 'aria-label': title } : { 'aria-labelledby': headingId })}
      className={`fy-input-card flex min-w-0 flex-col gap-3${embedded ? '' : ' kt-panel p-panel'}`}
      data-input-embedded={embedded ? '' : undefined}
      data-input-request={request.id}
      data-input-state={settled === null ? request.state : 'settled'}
    >
      {embedded ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {chain}
          {title === titleWords(request, agentName) ? null : (
            <span className="text-ui font-medium text-fg" data-input-title="">
              {title}
            </span>
          )}
          {target}
          {expiry}
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="m-0 min-w-0 text-row font-semibold text-fg" data-input-title="" id={headingId}>
              {title}
            </h3>
            {expiry}
          </header>
          {chain}
          {target}
        </>
      )}

      <div
        className="flex min-w-0 flex-col gap-1 rounded-control border border-border-strong bg-surface-2 p-3"
        data-input-facts=""
      >
        {facts === undefined ? (
          <p className="m-0 text-ui text-warn" data-input-observing="" role="status">
            {blocked ?? 'Ferretry is looking at the target again'}…
          </p>
        ) : (
          <>
            <p className="m-0 text-ui font-semibold text-fg">
              <span className="mono text-row" data-input-program="">
                {facts.program}
              </span>{' '}
              {facts.verb ?? 'is asking'}
              <span className="font-normal text-muted" data-input-echo="">
                {' '}
                · {facts.echo}
              </span>
            </p>
            {facts.promptLine === undefined || facts.promptLine === '' ? null : (
              <code className="mono block min-w-0 break-words text-cell text-fg" data-input-prompt-line="">
                {facts.promptLine}
              </code>
            )}
            {facts.fields === undefined ? null : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-cell text-muted" data-input-seen-fields="">
                {facts.fields.map(seen => (
                  <li data-input-seen-field={seen.key} key={seen.key}>
                    <span className="font-medium text-fg">{seen.label}</span> · {seen.words}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <p className="m-0 text-meta text-faint" data-input-agent-says="">
          {agentName} says: “{request.prompt}”
        </p>
      </div>

      {planMissLine === undefined ? null : (
        <p className="m-0 flex items-start gap-2 text-cell text-muted" data-input-plan-miss="">
          <ShieldQuestion aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
          <span>{planMissLine}</span>
        </p>
      )}

      {planFilledLine === undefined ? null : (
        <p className="m-0 text-cell text-muted" data-input-plan-filled="">
          {planFilledLine}
        </p>
      )}

      {request.pictured === true ? <FieldShot client={client} fields={fields} request={request} /> : null}

      {facts?.challenge === undefined ? null : (
        <p className="m-0 flex items-start gap-2 text-cell text-warn" data-input-challenge="" role="status">
          <ShieldQuestion aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
          <span>{facts.challenge}</span>
        </p>
      )}

      {request.risk === undefined || Risk === null || !showsHeaderRisk(request) ? null : (
        <p
          className={`m-0 flex items-start gap-2 text-cell ${RISK_TONE[request.risk.level]}`}
          data-input-risk={request.risk.level}
        >
          <Risk aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
          <span>{request.risk.reason}</span>
        </p>
      )}

      {request.lock === undefined ? null : (
        <p className="m-0 flex items-start gap-2 text-cell text-muted" data-input-lock={request.lock.seconds}>
          <Timer aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
          <span>
            Hidden from the ferret for {lockWords(request.lock)} after typing. {INPUT_LOCK_WORDS[request.lock.reason]}
          </span>
        </p>
      )}

      {settled === null && request.source !== undefined ? (
        <SealedPasteSection
          blocked={blocked}
          busy={cancelling}
          cancel={cancelButton}
          client={client}
          onRefresh={onRefresh}
          onSettled={text => {
            setSettled(text);
            onDone();
          }}
          request={request}
        />
      ) : settled === null ? (
        fields.length === 0 ? null : (
          <InputForm
            blocked={blocked}
            busy={cancelling}
            cancel={cancelButton}
            client={client}
            fields={fields}
            extra={setup}
            onRefresh={onRefresh}
            onSettled={(text, handTapped) => {
              setSettled(text);
              setAlways(handTapped === undefined ? undefined : alwaysUseFor(request.saved, handTapped));
              setTappedSignIn(handTapped?.signIn);
              onDone();
            }}
            request={request}
          />
        )
      ) : (
        <>
          <p className="m-0 text-ui text-ok" data-input-settled="" role="status">
            {settled}
          </p>
          {always === undefined ? null : <AlwaysUseLine always={always} client={client} />}
          {ruleOffer === undefined || tappedSignIn === undefined ? null : (
            <SignInRuleOffer askPasskey={ruleOffer.askPasskey} client={client} signIn={tappedSignIn} />
          )}
        </>
      )}

      {problem === null ? null : (
        <p className="m-0 text-ui text-err" role="alert">
          {problem}
        </p>
      )}

      {settled !== null || fields.length > 0 ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
          {cancelButton}
        </div>
      )}
    </section>
  );
}

interface PasteSectionProps {
  readonly request: InputRequest;
  readonly client: InputClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  readonly cancel: ReactNode;
  readonly onSettled: (text: string) => void;
  readonly onRefresh: (() => void) | undefined;
}

/**
 * A PASTE (docs/secure-copy.md): the ferret asks to paste a secure copy it holds. There is no field: the owner
 * allows it or cancels, and the daemon types the copy the request names. Its full card is a later phase.
 */
function SealedPasteSection({ request, client, blocked, busy, cancel, onSettled, onRefresh }: PasteSectionProps) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A paste the daemon never answered keeps its id, so pressing Allow again cannot paste twice.
  const pending = useRef<string | null>(null);
  const off = blocked !== undefined || sending || busy;
  const route = pasteRoute(request);

  const allow = async (): Promise<void> => {
    if (off) return;
    pending.current ??= crypto.randomUUID();
    const built = sealedBody(request, defaultSubmit(request), pending.current);
    // Unreachable while re-observing (Allow is disabled then), and said in words if it ever is.
    if (!built.ok) return void setFailure(built.problem);
    setFailure(null);
    setSending(true);
    try {
      await deliverInput(client, request, built.body);
      pending.current = null;
      onSettled(`Pasted into ${targetRef(request)}.`);
    } catch (cause) {
      const words = inputFailure(cause, request.target.kind);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'changed') onRefresh?.();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-input-paste="">
      <dl
        className="m-0 grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-control border border-border-strong bg-surface-2 p-3 text-ui"
        data-input-paste-route=""
      >
        <dt className="text-faint">Copy</dt>
        <dd className="m-0 min-w-0 break-words mono text-fg">{pastedWords(request)}</dd>
        <dt className="text-faint">From</dt>
        <dd className="m-0 min-w-0 break-words text-fg" data-input-paste-from="">
          {/* A path from the ferret's own files: isolated, so a right-to-left folder name cannot reorder it. */}
          <bdi dir="ltr">{route?.from}</bdi>
        </dd>
        <dt className="text-faint">Into</dt>
        <dd className="m-0 min-w-0 break-words font-medium text-fg" data-input-paste-to="">
          {route?.to}
        </dd>
      </dl>
      <p className="m-0 text-meta text-faint">
        You type nothing: Ferretry pastes the sealed value, which the ferret never sees.
      </p>
      {failure === null ? null : (
        <p className="m-0 text-ui text-err" data-input-failure="" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
        {cancel}
        <button
          className="kt-btn min-h-[44px]"
          data-input-allow=""
          data-variant="primary"
          disabled={off}
          onClick={() => void allow()}
          type="button"
        >
          {sending ? 'Pasting…' : 'Allow paste'}
        </button>
      </div>
    </div>
  );
}

interface FormProps {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly client: InputClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  /** The card's Cancel, drawn in the action row (left of Send). */
  readonly cancel: ReactNode;
  /** `handTapped`: the account the owner picked by hand (not the daemon's one-tap), which a default may be made of. */
  readonly onSettled: (text: string, handTapped?: InputSavedOffer) => void;
  readonly onRefresh: (() => void) | undefined;
  /** The "Set up automatic codes" panel, under the offers. */
  readonly extra: ReactNode;
}

type Nodes = Map<string, HTMLInputElement>;

interface FieldInputProps {
  readonly field: InputCardField;
  readonly request: InputRequest;
  readonly nodes: Nodes;
  readonly value: string;
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly many: boolean;
  /** What is wrong with the typed value, shown under the field (a card of several fields only). */
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onReveal: () => void;
  readonly onEnter: () => void;
}

function FieldInput({
  field,
  request,
  nodes,
  value,
  revealed,
  disabled,
  many,
  problem,
  onChange,
  onReveal,
  onEnter,
}: FieldInputProps) {
  const inputId = useId();
  const attributes = fieldAttributes(field.sensitivity, revealed);

  // React detaches a ref BEFORE passive cleanups run, so the field is emptied when it is detached.
  const attach = useCallback(
    (node: HTMLInputElement | null): void => {
      if (node !== null) {
        nodes.set(field.key, node);
        return;
      }
      const detached = nodes.get(field.key);
      if (detached !== undefined) detached.value = '';
      nodes.delete(field.key);
    },
    [nodes, field.key],
  );

  return (
    <div className="flex min-w-0 flex-col gap-2" data-input-field={field.key}>
      <label className="text-cell font-medium text-fg" htmlFor={inputId}>
        {field.label}
      </label>
      <div className="flex min-w-0 items-stretch gap-2">
        <input
          {...attributes}
          autoCapitalize="off"
          autoCorrect="off"
          className="kt-input min-h-[44px] min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-2 text-fg"
          data-input-value=""
          disabled={disabled}
          id={inputId}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && value !== '') {
              event.preventDefault();
              onEnter();
            }
          }}
          ref={attach}
          spellCheck={false}
          value={value}
        />
        {!revealable(field.sensitivity) ? null : (
          <button
            aria-label={`${revealed ? 'Hide' : 'Show'} what you typed${many ? ` in ${field.label}` : ''}`}
            aria-pressed={revealed}
            className="kt-btn min-h-[44px] min-w-[44px] justify-center"
            data-input-reveal=""
            onClick={onReveal}
            type="button"
          >
            {revealed ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
          </button>
        )}
      </div>
      {problem === undefined ? null : (
        <p className="m-0 text-meta text-err" data-input-field-problem="" role="alert">
          {problem}
        </p>
      )}
      <FieldFlags field={field} request={request} />
    </div>
  );
}

/**
 * The picture of the page the daemon took before anything was typed, with a box drawn on each field the values
 * go into. The picture and the boxes are the BROWSER's, not the agent's: the owner sees where the value lands.
 * A picture that cannot be fetched is simply not shown; the facts above still say what is there.
 */
function FieldShot({
  client,
  request,
  fields,
}: {
  readonly client: InputClient;
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
}) {
  const [shot, setShot] = useState<InputShot | null>(null);
  useEffect(() => {
    let live = true;
    readInputShot(client, request)
      .then(found => {
        if (live) setShot(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, request]);
  if (shot === null) return null;
  return (
    <figure className="relative m-0 min-w-0 overflow-hidden rounded-control border border-border" data-input-shot="">
      <img
        alt="The page where the values go, before anything was typed"
        className="block h-auto w-full"
        src={`data:image/png;base64,${shot.pngBase64}`}
      />
      {shotBoxes(request, fields, shot).map(box => (
        <span
          aria-hidden="true"
          className="absolute rounded-control outline outline-2 outline-accent"
          data-input-shot-box={box.key}
          key={box.key}
          style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
        />
      ))}
    </figure>
  );
}

/**
 * A field's own flags: the red "the ferret can see this" of a plain field and the daemon's risk for the rest. Drawn
 * with the field when it is typed AND in the field summary above a saved login's button, so a one-tap send never
 * goes out with a warning the owner was not shown.
 */
function FieldFlags({ field, request }: { readonly field: InputCardField; readonly request: InputRequest }) {
  const riskLine = fieldRiskLine(request, field);
  const RiskIcon = riskLine === undefined ? null : RISK_ICON[riskLine.level];
  return (
    <>
      {field.sensitivity === 'plain' ? (
        <p className="m-0 flex items-start gap-2 text-meta text-err" data-input-plain="">
          <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          <span>{plainFlagWords(field)}</span>
        </p>
      ) : null}
      {riskLine === undefined || RiskIcon === null ? null : (
        <p
          className={`m-0 flex items-start gap-2 text-meta ${RISK_TONE[riskLine.level]}`}
          data-input-field-risk={riskLine.level}
        >
          <RiskIcon aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          <span>{riskLine.reason}</span>
        </p>
      )}
    </>
  );
}

/** Each field a saved login would fill, by name, with its flags: what the owner sees instead of the inputs. */
function FieldSummary({
  fields,
  request,
}: {
  readonly fields: readonly InputCardField[];
  readonly request: InputRequest;
}) {
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-input-field-summary="">
      {fields.map(field => (
        <li className="flex min-w-0 flex-col gap-1" data-input-summary-field={field.key} key={field.key}>
          <span className="text-cell font-medium text-fg">
            {field.label} <span className="font-normal text-muted">· {sensitivityWords(field)}</span>
          </span>
          <FieldFlags field={field} request={request} />
        </li>
      ))}
    </ul>
  );
}

const SENSITIVITY_WORDS = {
  secret: 'secret',
  private: 'private',
  code: 'one-time code, the ferret can see it',
  plain: 'not secret',
} as const;

/** The label keeps "the ferret can see it" unless the risk line drawn for the field (on top or beside it) already says it. */
const sensitivityWords = (field: InputCardField): string =>
  field.sensitivity === 'code' && field.risk?.reason.includes('the ferret can see it') === true
    ? 'one-time code'
    : SENSITIVITY_WORDS[field.sensitivity];

/**
 * The quiet line after a hand-tap: "Always use for <project>". It is the OWNER's tap on this button that writes the
 * default (`PUT /v1/accounts/defaults`); the owner's own act, in effect at once (a paired device confirms with its passkey). A failure is said
 * in words and never changes what was already sent.
 */
function AlwaysUseLine({ always, client }: { readonly always: AlwaysUse; readonly client: InputClient }) {
  const [state, setState] = useState<'idle' | 'writing' | 'saved'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const write = async (): Promise<void> => {
    setState('writing');
    setFailure(null);
    try {
      await putAccountDefault(client, always.body);
      setState('saved');
    } catch (cause) {
      setState('idle');
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-input-always="">
      {state === 'saved' ? (
        <p className="m-0 text-meta text-ok" data-input-always-saved="" role="status">
          {always.label} is now the default for {always.project} at {always.key}.
        </p>
      ) : (
        <>
          <button
            className="kt-btn min-h-[44px] self-start"
            data-input-always-button=""
            disabled={state === 'writing'}
            onClick={() => void write()}
            type="button"
          >
            Always use for {always.project}
          </button>
          <p className="m-0 text-meta text-muted">
            Makes {always.label} the default for {always.key} in {always.project}.
          </p>
        </>
      )}
      {failure === null ? null : (
        <p className="m-0 text-meta text-err" data-input-always-failure="" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

function InputForm({ request, fields, client, blocked, busy, cancel, onSettled, onRefresh, extra }: FormProps) {
  const nodes = useRef<Nodes>(new Map());
  const { primary, others: rest } = splitOffers(request.saved);
  const pickOne = pickOneOffers(request.saved);
  const others = rest.filter(offer => !pickOne.includes(offer));
  const reasonLine = choiceReasonWords(request.saved, primary);
  const signInLine = signInWords(request.saved);
  const offering = primary !== undefined || pickOne.length > 0;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, boolean>>>({});
  const [typing, setTyping] = useState(!offering);
  const [submit, setSubmit] = useState(() => defaultSubmit(request));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A send the daemon never answered keeps its id, so pressing Send again cannot type twice.
  const pending = useRef<string | null>(null);

  // "Save as" keeps the one typed value, or a login card's username and password together.
  const only = fields.length === 1 ? fields[0] : undefined;
  const [save, setSave] = useState(() => initialSaveDraft(request.saved));
  const many = only === undefined;

  const clear = useCallback((): void => {
    setValues({});
    setRevealed({});
    for (const node of nodes.current.values()) node.value = '';
  }, []);

  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clear]);

  const off = blocked !== undefined || sending || busy;
  const value = only === undefined ? '' : (values[only.key] ?? '');
  const saving = cardOffersSave(request, fields);
  const existing = updatedEntry(request.saved, save.id);
  const saveReason = cardSaveBlock(request, fields, values);
  // "Too short to save" is said only once something is typed AND Save as is ticked: never before the owner acts.
  const typedSomething = fields.some(field => (values[field.key] ?? '') !== '');
  const saveSaid = save.enabled && typedSomething ? saveReason : undefined;
  const draftProblem = saveDraftProblem(save, request.saved);
  const update = request.saved?.update;
  const differentLine = differentAccountWords(request.saved);
  const askUsername = savesUsername(fields, save);
  const saveFieldId = useId();
  // "Type a different one" over a saved account: what is typed is someone else's until the owner says otherwise.
  const typeInstead = (): void => {
    setTyping(true);
    setSave(current =>
      current.mode === undefined
        ? current
        : { ...initialSaveDraft(request.saved, { typedInstead: true }), enabled: current.enabled },
    );
  };
  const ready = typedReady(fields, values);

  const mintId = (): string => {
    pending.current ??= crypto.randomUUID();
    return pending.current;
  };

  const send = async (
    build: (deliveryId: string) => ReturnType<typeof savedBody>,
    handTapped?: InputSavedOffer,
  ): Promise<void> => {
    if (off) return;
    const built = build(mintId());
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    setFailure(null);
    setSending(true);
    // The body now holds the padded values; the fields do not keep them a moment longer.
    clear();
    try {
      const result = await deliverInput(client, request, built.body);
      pending.current = null;
      const label = built.body.save?.label ?? '';
      const kept = savedOutcomeWords(result, label);
      onSettled(`Sent to ${targetRef(request)}.${kept === undefined ? '' : ` ${kept}`}`, handTapped);
    } catch (cause) {
      const words = inputFailure(cause, request.target.kind);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'changed') onRefresh?.();
    } finally {
      setSending(false);
    }
  };

  const tapOffer = (offer: InputSavedOffer, factor?: TwoFactorId): void =>
    void send(
      deliveryId =>
        savedBody(request, offer.id, submit, deliveryId, {
          ...(offer.signIn === undefined ? {} : { signIn: offer.signIn }),
          ...(factor === undefined ? {} : { factor }),
        }),
      offer === primary ? undefined : offer,
    );

  const severalMatched = (request.saved?.offers ?? []).filter(each => each.matched).length > 1;
  const codeButtons = (offer: InputSavedOffer, lead: boolean): ReactNode =>
    (offer.codes ?? []).map((key, index) => {
      const checked = codeCheckedWords(key);
      const username = offerUsername(offer);
      return (
        <button
          className="kt-btn !h-auto min-h-[44px] min-w-0 flex-col items-start justify-center py-2 text-left"
          data-input-code-key={key.factor}
          data-input-offer={offer.id}
          data-input-offer-matched=""
          data-variant={lead && index === 0 ? 'primary' : undefined}
          disabled={off}
          key={key.factor}
          onClick={() => tapOffer(offer, key.factor)}
          type="button"
        >
          <span className="min-w-0 break-words">{codeButtonWords(key)}</span>
          {lead && !severalMatched ? null : (
            <span className="text-meta font-normal opacity-80" data-input-code-account="">
              {username === undefined ? offer.label : `${offer.label} · ${username}`}
            </span>
          )}
          {checked === undefined ? null : (
            <span
              className={`text-meta font-normal ${key.checked === 'failed' ? 'text-warn' : 'opacity-80'}`}
              data-input-code-checked={key.checked}
            >
              {checked}
            </span>
          )}
        </button>
      );
    });
  const oneFactor = oneFactorLine(
    primary?.codes === undefined ? pickOne.find(offer => offer.codes !== undefined) : primary,
  );
  const othersOneFactor = oneFactorLine(others.find(offer => offer.codes !== undefined));

  const sendTyped = (): void =>
    void send(deliveryId =>
      only === undefined
        ? typedFieldsBody({ request, fields, values, submit, deliveryId, save })
        : typedBody({ request, field: only, value, submit, save, deliveryId }),
    );

  const offerButton = (offer: InputSavedOffer, primaryTap: boolean): ReactNode => {
    const username = offerUsername(offer);
    return (
      <button
        className="kt-btn !h-auto min-h-[44px] min-w-0 flex-col items-start justify-center py-2 text-left"
        data-input-offer={offer.id}
        data-input-offer-matched={offer.matched ? '' : undefined}
        data-variant={primaryTap ? 'primary' : undefined}
        disabled={off}
        key={offer.id}
        onClick={() => tapOffer(offer)}
        type="button"
      >
        <span className="min-w-0 break-words">{primaryTap ? savedButtonWords(offer) : offer.label}</span>
        {username === undefined ? null : <span className="text-meta font-normal opacity-80">{username}</span>}
        {offer.hinted === true ? (
          <span className="text-meta font-normal opacity-80" data-input-hinted="">
            the ferret suggested this
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-input-form="">
      {signInLine === undefined ? null : (
        <p className="m-0 text-cell font-medium text-fg" data-input-sign-in="">
          {signInLine}
        </p>
      )}

      {differentLine === undefined ? null : (
        <p className="m-0 text-cell font-medium text-warn" data-input-different-account="" role="status">
          {differentLine}
        </p>
      )}

      {typing ? (
        <div className="flex min-w-0 flex-col gap-3">
          {fields.map(field => (
            <FieldInput
              disabled={off}
              field={field}
              key={field.key}
              many={many}
              nodes={nodes.current}
              onChange={next => setValues(current => ({ ...current, [field.key]: next }))}
              onEnter={() => {
                if (ready) sendTyped();
              }}
              onReveal={() => setRevealed(current => ({ ...current, [field.key]: current[field.key] !== true }))}
              problem={many ? fieldProblem(field, values[field.key] ?? '') : undefined}
              request={request}
              revealed={revealed[field.key] === true}
              value={values[field.key] ?? ''}
            />
          ))}
        </div>
      ) : null}

      {!offering || typing ? null : <FieldSummary fields={fields} request={request} />}

      {primary === undefined || typing ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-stretch gap-2">
            {primary.codes === undefined ? offerButton(primary, true) : codeButtons(primary, true)}
            <button className="kt-btn min-h-[44px]" data-input-type-instead="" onClick={typeInstead} type="button">
              Type a different one
            </button>
          </div>
          {reasonLine === undefined || (primary.codes !== undefined && primary.why === 'only') ? null : (
            <p className="m-0 text-meta text-muted" data-input-why={primary.why}>
              {reasonLine}
            </p>
          )}
        </div>
      )}

      {pickOne.length === 0 || typing ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-input-pick-one="">
          <p className="m-0 text-cell font-medium text-fg" data-input-pick-one-line="">
            {pickOneWords(pickOne.length)}
          </p>
          <div className="flex flex-col items-stretch gap-2">
            {pickOne.map(offer => (offer.codes === undefined ? offerButton(offer, false) : codeButtons(offer, false)))}
          </div>
          <button
            className="kt-btn min-h-[44px] self-start"
            data-input-type-instead=""
            onClick={typeInstead}
            type="button"
          >
            Type a different one
          </button>
        </div>
      )}

      {oneFactor === undefined || typing ? null : (
        <p className="m-0 text-meta text-muted" data-input-one-factor="">
          {oneFactor}
        </p>
      )}

      {typing && saving ? (
        <div className="flex min-w-0 flex-col gap-2" data-input-save="">
          <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
            <input
              checked={save.enabled}
              data-input-save-tick=""
              disabled={off}
              onChange={event => setSave(current => ({ ...current, enabled: event.target.checked }))}
              type="checkbox"
            />
            Save to Accounts
          </label>
          {saveSaid === undefined ? null : (
            <p className="m-0 text-meta text-warn" data-input-save-reason="" role="status">
              {saveSaid}
            </p>
          )}
          {save.enabled && askUsername ? (
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              Username
              <input
                aria-describedby={request.saved?.typedUsername === undefined ? undefined : `${saveFieldId}-who`}
                autoCapitalize="none"
                autoComplete="off"
                className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg read-only:opacity-70"
                data-input-save-username=""
                disabled={off}
                onChange={event => setSave(current => editSaveUsername(request.saved, current, event.target.value))}
                readOnly={usernameLocked(request.saved, save)}
                spellCheck={false}
                value={save.username}
              />
              {request.saved?.typedUsername === undefined || usernameLocked(request.saved, save) ? null : (
                <span className="text-meta text-muted" data-input-save-username-note="" id={`${saveFieldId}-who`}>
                  What the ferret typed on the page. Check it is right.
                </span>
              )}
            </label>
          ) : null}
          {save.enabled && save.mode !== undefined && update !== undefined ? (
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" data-input-save-mode={save.mode}>
              <legend className="sr-only">Where to save it</legend>
              <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
                <input
                  checked={save.mode === 'new'}
                  data-input-save-new=""
                  disabled={off}
                  name={`${saveFieldId}-mode`}
                  onChange={() => setSave(current => switchSaveMode(request.saved, current, 'new'))}
                  type="radio"
                />
                Save as a new account
              </label>
              <label className="flex min-h-[44px] min-w-0 items-center gap-2 text-cell text-fg">
                <input
                  checked={save.mode === 'update'}
                  data-input-save-update=""
                  disabled={off}
                  name={`${saveFieldId}-mode`}
                  onChange={() => setSave(current => switchSaveMode(request.saved, current, 'update'))}
                  type="radio"
                />
                <span className="min-w-0 break-words">{updateChoiceWords(update)}</span>
              </label>
            </fieldset>
          ) : null}
          {save.enabled && save.mode !== 'update' ? (
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              Name
              <input
                autoComplete="off"
                className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                data-input-save-label=""
                disabled={off}
                onChange={event => setSave(current => editSaveLabel(request.saved, current, event.target.value))}
                value={save.label}
              />
            </label>
          ) : null}
          {save.enabled && save.mode !== 'update' ? (
            <details className="min-w-0" data-input-save-more="">
              <summary className="cursor-pointer text-meta text-muted">More</summary>
              <label className="mt-2 flex min-w-0 flex-col gap-1 text-meta text-muted">
                Name in the terminal
                <input
                  aria-describedby={`${saveFieldId}-cli`}
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="kt-input mono min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                  data-input-save-id=""
                  disabled={off}
                  onChange={event =>
                    setSave(current => ({ ...current, id: normalizeHandle(event.target.value), idEdited: true }))
                  }
                  spellCheck={false}
                  value={save.id}
                />
              </label>
              <p className="m-0 mt-1 text-meta text-muted" data-input-save-cli-note="" id={`${saveFieldId}-cli`}>
                How <span className="mono">fy account</span> names this account. It is not an environment variable.
              </p>
            </details>
          ) : null}
          {save.enabled && saveReason === undefined && save.mode === 'update' && update !== undefined ? (
            <p className="m-0 text-meta text-warn" data-input-save-updates="">
              {updateWords(update)}
            </p>
          ) : null}
          {save.enabled && saveReason === undefined && save.mode === undefined && existing !== undefined ? (
            <p className="m-0 text-meta text-warn" data-input-save-updates="">
              updates {existing.label}
            </p>
          ) : null}
          {save.enabled && draftProblem !== undefined && saveReason === undefined ? (
            <p className="m-0 text-meta text-err" role="alert">
              {draftProblem}
            </p>
          ) : null}
        </div>
      ) : null}

      {others.length === 0 ? null : (
        <details className="min-w-0" data-input-others="">
          <summary className="cursor-pointer text-cell text-muted">Choose another account</summary>
          <div className="mt-2 flex flex-col items-stretch gap-2">
            {others.map(offer => (offer.codes === undefined ? offerButton(offer, false) : codeButtons(offer, false)))}
            {othersOneFactor === undefined ? null : (
              <p className="m-0 text-meta text-muted" data-input-one-factor="">
                {othersOneFactor}
              </p>
            )}
          </div>
        </details>
      )}

      {extra}

      {offersPressEnter(request) ? (
        <label className="flex items-center gap-2 text-cell text-fg">
          <input
            checked={submit}
            data-input-enter=""
            disabled={off}
            onChange={event => setSubmit(event.target.checked)}
            type="checkbox"
          />
          Press Enter for me
        </label>
      ) : null}

      {blocked === undefined ? null : (
        <p className="m-0 text-meta text-warn" data-input-blocked="" role="status">
          {blocked}
        </p>
      )}
      {failure === null ? null : (
        <p className="m-0 text-ui text-err" data-input-failure="" role="alert">
          {failure}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
        {cancel}
        {typing ? (
          <button
            className="kt-btn min-h-[44px] justify-center"
            data-input-send=""
            data-variant="primary"
            disabled={off || !ready || (save.enabled && saveReason === undefined && draftProblem !== undefined)}
            onClick={sendTyped}
            type="button"
          >
            {sending ? 'Sending…' : save.enabled && saveReason !== undefined ? 'Send without saving' : 'Send'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
