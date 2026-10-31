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
 *   - otherwise (or after "Type a different one") a masked field, a local eye that is not remembered,
 *     "Press Enter for me", and "Save as" when this kind of value is ever kept;
 *   - the other saved logins stay selectable by hand under "Choose another saved login".
 *
 * THE VALUE LIVES ONLY IN THE CONTROLLED FIELD until Send. It is never put in a draft store, storage, a query
 * cache, a URL or a log; it is cleared on Send, when the field unmounts and when the page is hidden. A saved
 * value NEVER passes through this app: tapping a login sends its handle and the daemon types it.
 *
 * ONE FIELD TODAY, MANY LATER. The card draws `fields` as a list and each field keeps its own state and its own
 * Send; the multi-field card (username + password on one card) adds fields and rewrites nothing.
 */

import type { InputRequest, InputSavedOffer } from '@ferretry/protocol';
import { Eye, EyeOff, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cancelInput, deliverInput, type InputClient } from '../../lib/input-api.ts';
import {
  defaultSubmit,
  expiryWords,
  fieldAttributes,
  type InputCardField,
  initialSaveDraft,
  inputFailure,
  normalizeHandle,
  observedWords,
  offersPressEnter,
  offersSave,
  offerUsername,
  PLAIN_NOTICE,
  pastedWords,
  saveBlock,
  saveDraftProblem,
  savedBody,
  savedButtonWords,
  savedOutcomeWords,
  sealedBody,
  sendBlock,
  splitOffers,
  targetRef,
  titleWords,
  typedBody,
  updatedEntry,
} from '../../lib/input-card.ts';

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
          </>
        )}
        <p className="m-0 text-meta text-faint" data-input-agent-says="">
          {agentName} says: “{request.prompt}”
        </p>
      </div>

      {request.risk === undefined || Risk === null ? null : (
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
        fields.map((field, index) => (
          <InputFieldSection
            blocked={blocked}
            busy={cancelling}
            cancel={index === fields.length - 1 ? cancelButton : null}
            client={client}
            field={field}
            key={field.key}
            onRefresh={onRefresh}
            onSettled={text => {
              setSettled(text);
              onDone();
            }}
            request={request}
          />
        ))
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
      <p className="m-0 text-ui text-fg">
        Pastes <span className="mono">{pastedWords(request)}</span>. You type nothing.
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

interface FieldSectionProps {
  readonly request: InputRequest;
  readonly field: InputCardField;
  readonly client: InputClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  /** The card's Cancel, drawn in this field's action row (left of Send) when this is the last field. */
  readonly cancel: ReactNode;
  readonly onSettled: (text: string) => void;
  readonly onRefresh: (() => void) | undefined;
}

function InputFieldSection({ request, field, client, blocked, busy, cancel, onSettled, onRefresh }: FieldSectionProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const { primary, others } = splitOffers(field.saved);
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [typing, setTyping] = useState(primary === undefined);
  const [submit, setSubmit] = useState(() => defaultSubmit(request));
  const [save, setSave] = useState(() => initialSaveDraft(field.saved));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A send the daemon never answered keeps its id, so pressing Send again cannot type twice.
  const pending = useRef<string | null>(null);

  // React detaches a ref BEFORE passive cleanups run, so the field is emptied when it is detached.
  const attach = useCallback((node: HTMLInputElement | null): void => {
    if (node === null && input.current !== null) input.current.value = '';
    input.current = node;
  }, []);

  const clear = useCallback((): void => {
    setValue('');
    setRevealed(false);
    if (input.current !== null) input.current.value = '';
  }, []);

  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clear]);

  const attributes = fieldAttributes(field.sensitivity, revealed);
  const off = blocked !== undefined || sending || busy;
  const existing = updatedEntry(field.saved, save.id);
  const saveReason = saveBlock(field, value);
  const draftProblem = saveDraftProblem(save);

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
    // The body now holds the padded value; the field does not keep it a moment longer.
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

  const sendTyped = (): void => void send(deliveryId => typedBody({ request, field, value, submit, save, deliveryId }));

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
    <div className="flex min-w-0 flex-col gap-3" data-input-field={field.key}>
      {typing ? (
        <div className="flex min-w-0 flex-col gap-2">
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
              disabled={off}
              id={inputId}
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && value !== '') {
                  event.preventDefault();
                  sendTyped();
                }
              }}
              ref={attach}
              spellCheck={false}
              value={value}
            />
            {field.sensitivity === 'plain' ? null : (
              <button
                aria-label={revealed ? 'Hide what you typed' : 'Show what you typed'}
                aria-pressed={revealed}
                className="kt-btn min-h-[44px] min-w-[44px] justify-center"
                data-input-reveal=""
                onClick={() => setRevealed(current => !current)}
                type="button"
              >
                {revealed ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
              </button>
            )}
          </div>
          {field.sensitivity === 'plain' ? (
            <p className="m-0 text-meta text-warn" data-input-plain="">
              {PLAIN_NOTICE}
            </p>
          ) : null}
        </div>
      ) : null}

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

      {typing && offersSave(field) ? (
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

      {cancel === null && !typing ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
          {cancel}
          {typing ? (
            <button
              className="kt-btn min-h-[44px] justify-center"
              data-input-send=""
              data-variant="primary"
              disabled={off || value === '' || (save.enabled && saveReason === undefined && draftProblem !== undefined)}
              onClick={sendTyped}
              type="button"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
