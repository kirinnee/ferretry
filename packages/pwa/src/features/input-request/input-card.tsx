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
 *   - the other saved logins stay selectable by hand under "Choose another saved login".
 *
 * A CARD OF SEVERAL FIELDS (a login's email and password) is ONE Send: it waits until every field is typed, and
 * each PLAIN field carries its own red flag, because the ferret can see that value. A saved login is one tap for
 * the whole card.
 *
 * THE VALUES LIVE ONLY IN THE CONTROLLED FIELDS until Send. They are never put in a draft store, storage, a query
 * cache, a URL or a log; every field is cleared on Send, when the card unmounts and when the page is hidden. A saved
 * value NEVER passes through this app: tapping a login sends its handle and the daemon types it.
 */

import type { InputRequest, InputSavedOffer } from '@ferretry/protocol';
import { Eye, EyeOff, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cancelInput, deliverInput, type InputClient } from '../../lib/input-api.ts';
import {
  cardOffersSave,
  cardSaveBlock,
  chainWords,
  defaultSubmit,
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
  offerUsername,
  pastedWords,
  plainFlagWords,
  saveDraftProblem,
  savedBody,
  savedButtonWords,
  savedOutcomeWords,
  sealedBody,
  sendBlock,
  showsHeaderRisk,
  splitOffers,
  targetRef,
  titleWords,
  typedBody,
  typedFieldsBody,
  typedReady,
  updatedEntry,
} from '../../lib/input-card.ts';
import { pasteRoute } from '../../lib/secure-copy.ts';

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
}

const RISK_ICON = { green: ShieldCheck, amber: ShieldQuestion, red: ShieldAlert } as const;
const RISK_TONE = { green: 'text-ok', amber: 'text-warn', red: 'text-err' } as const;

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
}: InputCardProps) {
  const headingId = useId();
  const now = useNow(fixedNow);
  const [settled, setSettled] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const facts = observedWords(request);
  const blocked = sendBlock(request, now);
  const Risk = request.risk === undefined ? null : RISK_ICON[request.risk.level];

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setProblem(null);
    try {
      await cancelInput(client, request);
      setSettled('Cancelled. Nothing was typed.');
      onDone();
    } catch (cause) {
      setProblem(inputFailure(cause).text);
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
      {...(embedded ? { 'aria-label': titleWords(request, agentName) } : { 'aria-labelledby': headingId })}
      className={`fy-input-card flex min-w-0 flex-col gap-3${embedded ? '' : ' kt-panel p-panel'}`}
      data-input-embedded={embedded ? '' : undefined}
      data-input-request={request.id}
      data-input-state={settled === null ? request.state : 'settled'}
    >
      {embedded ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {chain}
          {target}
          {expiry}
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="m-0 min-w-0 text-row font-semibold text-fg" data-input-title="" id={headingId}>
              {titleWords(request, agentName)}
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
              is asking
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
            onRefresh={onRefresh}
            onSettled={text => {
              setSettled(text);
              onDone();
            }}
            request={request}
          />
        )
      ) : (
        <p className="m-0 text-ui text-ok" data-input-settled="" role="status">
          {settled}
        </p>
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
      const words = inputFailure(cause);
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
          {route?.from}
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
  readonly onSettled: (text: string) => void;
  readonly onRefresh: (() => void) | undefined;
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
        {field.sensitivity === 'plain' ? null : (
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
            {field.label} <span className="font-normal text-muted">· {SENSITIVITY_WORDS[field.sensitivity]}</span>
          </span>
          <FieldFlags field={field} request={request} />
        </li>
      ))}
    </ul>
  );
}

const SENSITIVITY_WORDS = { secret: 'secret', private: 'one-time code', plain: 'not secret' } as const;

function InputForm({ request, fields, client, blocked, busy, cancel, onSettled, onRefresh }: FormProps) {
  const nodes = useRef<Nodes>(new Map());
  const { primary, others } = splitOffers(request.saved);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, boolean>>>({});
  const [typing, setTyping] = useState(primary === undefined);
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
  const draftProblem = saveDraftProblem(save);
  const ready = typedReady(fields, values);

  const mintId = (): string => {
    pending.current ??= crypto.randomUUID();
    return pending.current;
  };

  const send = async (build: (deliveryId: string) => ReturnType<typeof savedBody>): Promise<void> => {
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
      onSettled(`Sent to ${targetRef(request)}.${kept === undefined ? '' : ` ${kept}`}`);
    } catch (cause) {
      const words = inputFailure(cause);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'changed') onRefresh?.();
    } finally {
      setSending(false);
    }
  };

  const tapOffer = (offer: InputSavedOffer): void =>
    void send(deliveryId => savedBody(request, offer.id, submit, deliveryId));

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
        className="kt-btn min-h-[44px] min-w-0 flex-col items-start justify-center text-left"
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

      {primary === undefined || typing ? null : <FieldSummary fields={fields} request={request} />}

      {primary === undefined || typing ? null : (
        <div className="flex flex-wrap items-stretch gap-2">
          {offerButton(primary, true)}
          <button
            className="kt-btn min-h-[44px]"
            data-input-type-instead=""
            onClick={() => setTyping(true)}
            type="button"
          >
            Type a different one
          </button>
        </div>
      )}

      {typing && saving ? (
        <div className="flex min-w-0 flex-col gap-2" data-input-save="">
          <label className="flex items-center gap-2 text-cell text-fg">
            <input
              checked={save.enabled && saveReason === undefined}
              data-input-save-tick=""
              disabled={off || saveReason !== undefined}
              onChange={event => setSave(current => ({ ...current, enabled: event.target.checked }))}
              type="checkbox"
            />
            Save as
          </label>
          {saveReason === undefined ? null : (
            <p className="m-0 text-meta text-muted" data-input-save-reason="">
              {saveReason}
            </p>
          )}
          {save.enabled && saveReason === undefined ? (
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted">
                Label
                <input
                  autoComplete="off"
                  className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                  data-input-save-label=""
                  onChange={event => setSave(current => ({ ...current, label: event.target.value }))}
                  value={save.label}
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted">
                Handle
                <input
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="kt-input mono min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                  data-input-save-id=""
                  onChange={event => setSave(current => ({ ...current, id: normalizeHandle(event.target.value) }))}
                  spellCheck={false}
                  value={save.id}
                />
              </label>
            </div>
          ) : null}
          {save.enabled && saveReason === undefined && existing !== undefined ? (
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
          <summary className="cursor-pointer text-cell text-muted">Choose another saved login</summary>
          <div className="mt-2 flex flex-col items-stretch gap-2">{others.map(offer => offerButton(offer, false))}</div>
        </details>
      )}

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
            {sending ? 'Sending…' : 'Send'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
