/**
 * THE INPUT CARD — an agent is stuck at a password, `sudo`, one-time-code or 2FA prompt and only the owner knows the
 * value (docs/input-requests.md, "The agenda card").
 *
 * WHAT THE CARD SHOWS, top to bottom: who needs what and where, what the DAEMON saw at that target (drawn large: the
 * program, whether typing is hidden, the prompt line), the ferret's own words small (they are a claim, not evidence),
 * the risk flag, then the way in: one masked field per value, each with a local eye that is not remembered, and "Press
 * Enter for me".
 *
 * THE VALUES LIVE ONLY IN THE FIELDS' OWN DOM NODES until Send (I6): the fields are UNCONTROLLED, so React never copies
 * what is typed into the `value` attribute (and so not into the page's markup). The card keeps only whether each field
 * is filled and what is wrong with it, reads the values once on Send, and never puts them in a draft store, storage, a
 * query cache, a URL or a log; every field is cleared on Send, when the card unmounts and when the page is hidden.
 *
 * ENTER (I51): the tick starts on for an owner default and for a terminal secret, off for a browser page; the
 * agent presses it itself when it said so, and then there is no tick at all.
 */
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cancelInput, deliverInput } from '../../lib/input-api.ts';
import {
  defaultSubmit,
  differentFromWords,
  expiryWords,
  fieldAttributes,
  fieldsOf,
  fieldStateOf,
  type FieldState,
  type InputCardField,
  inputFailure,
  offerBody,
  offerCodes,
  offerElsewhereWords,
  offerFillsWords,
  offerSentWords,
  offersCodesSlot,
  offersPressEnter,
  offerWhyWords,
  offerWords,
  HIDE_OTHER_ACCOUNTS_WORDS,
  oneFactorLine,
  OTHER_ACCOUNT_WORDS,
  savedChoices,
  settledSlotProps,
  signInNote,
  allowWords,
  pastedWords,
  pasteField,
  pasteRoute,
  pasteSize,
  plainFlagWords,
  replacesSecret,
  revealable,
  sealedBody,
  sendBlock,
  sentWords,
  targetRef,
  titleWords,
  typedBody,
  typedReady,
} from '../../lib/input-card.ts';
import type { InputRequest, InputSavedOffer } from '../../../contract/index.ts';
import { Eye, EyeOff, ShieldAlert, type VaultClient } from '../../shell.tsx';
import { CodeButtons, CodesSlot } from './code-offers.tsx';
import { FieldShot } from './field-shot.tsx';
import { SettledSlot } from './settled-slot.tsx';

/** The style hook of the input box: a class name, kept as it is (not owner text). */
const INPUT_CLASS = 'fy-input-card';

export interface InputCardProps {
  readonly request: InputRequest;
  readonly client: VaultClient;
  /** Who is asking, as the page names the ferret. */
  readonly agentName?: string;
  /** Fixed clock for the countdown (tests); absent: the real one, ticking. */
  readonly now?: number;
  /** The request is settled (sent or cancelled): the host re-reads. */
  readonly onDone: () => void;
  /** The daemon says the facts moved: the host reads the request again. */
  readonly onRefresh?: () => void;
  /**
   * Whether the card holds the view it is drawn in: `true` while a Send or a Cancel from here is on its way; `false`
   * once it has nothing more to show, with the words it settled in. Called only when it changes.
   */
  readonly onHold?: (holding: boolean, settled?: string) => void;
  /** Drawn inside an ask, which already has the title and the frame: no panel and no heading of its own. */
  readonly embedded?: boolean;
}

const useNow = (fixed: number | undefined): number => {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
};

/** What the daemon saw at the target, as one short statement; `undefined` while it looks again. */
function factsOf(
  request: InputRequest,
): { program: string; verb: string; echo?: string; promptLine?: string } | undefined {
  const seen = request.observed;
  if (seen === undefined) return undefined;
  if (seen.kind === 'terminal')
    return {
      program: seen.program ?? seen.foreground.comm,
      verb: 'is asking',
      echo: seen.echo === 'off' ? 'typing hidden' : seen.echo === 'on' ? 'typing shows' : 'echo unknown',
      ...(seen.promptLine === '' ? {} : { promptLine: seen.promptLine }),
    };
  if (seen.kind === 'page') {
    let host = seen.origin;
    try {
      host = new URL(seen.origin).host.toLowerCase();
    } catch {
      // The origin is shown as the daemon wrote it.
    }
    return { program: host, verb: 'is asking', echo: seen.secure ? 'https' : 'not https' };
  }
  return { program: seen.name, verb: 'in the secret store', echo: seen.exists ? 'exists' : 'new' };
}

type Nodes = Map<string, HTMLInputElement>;

interface FieldInputProps {
  readonly field: InputCardField;
  readonly nodes: Nodes;
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly many: boolean;
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onReveal: () => void;
  readonly onEnter: () => void;
}

function FieldInput({ field, nodes, revealed, disabled, many, problem, onChange, onReveal, onEnter }: FieldInputProps) {
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
            if (event.key === 'Enter' && event.currentTarget.value !== '') {
              event.preventDefault();
              onEnter();
            }
          }}
          ref={attach}
          spellCheck={false}
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
      {field.sensitivity !== 'plain' ? null : (
        <p className="m-0 flex items-start gap-2 text-meta text-err" data-input-plain-flag="">
          <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          {plainFlagWords(field)}
        </p>
      )}
    </div>
  );
}

interface FormProps {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly client: VaultClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  readonly cancel: ReactNode;
  /** Sent: the words it settled in, and the saved account the owner tapped (none for a typed value). */
  readonly onSettled: (words: string, used?: InputSavedOffer) => void;
  readonly onSending: (sending: boolean) => void;
  readonly onRefresh?: (() => void) | undefined;
  /** What an installed plugin draws under the saved accounts while the card asks a code (the codes slot), if anything. */
  readonly codesSlot?: ReactNode;
}

interface OfferButtonProps {
  readonly offer: InputSavedOffer;
  readonly disabled: boolean;
  readonly onUse: () => void;
}

/**
 * ONE SAVED ACCOUNT, one tap. It shows the owner's own words (the account's label and username, what it would type,
 * why it is first); the value is the daemon's and never reaches this card, so there is nothing here to echo. A click
 * that is the second or later of one gesture (`detail > 1`) chooses nothing.
 */
function OfferButton({ offer, disabled, onUse }: OfferButtonProps) {
  const why = offerWhyWords(offer);
  const elsewhere = offerElsewhereWords(offer);
  const primary = offer.primary === true;
  return (
    <button
      aria-label={`Use ${offerWords(offer)}`}
      className={`flex min-h-[44px] w-full min-w-0 flex-col items-start gap-0.5 rounded-control border bg-surface-2 px-3 py-2 text-left text-fg ${primary ? 'border-accent' : 'border-border-strong'}`}
      data-input-offer={offer.id}
      data-input-primary={primary ? '' : undefined}
      disabled={disabled}
      onClick={event => {
        // A double click or double tap lands its second click wherever the first one's change left a button: only the
        // first click of a gesture is a choice, so the owner never delivers an account they did not aim at.
        if (event.detail > 1) return;
        onUse();
      }}
      type="button"
    >
      <span className="block min-w-0 break-words text-left font-medium">{offerWords(offer)}</span>
      <span className="block min-w-0 break-words text-left text-meta font-normal" data-input-offer-detail="">
        {[offerFillsWords(offer), why, elsewhere].filter(each => each !== undefined).join(' · ')}
      </span>
    </button>
  );
}

function InputForm({
  request,
  fields,
  client,
  blocked,
  busy,
  cancel,
  onSettled,
  onSending,
  onRefresh,
  codesSlot,
}: FormProps) {
  const nodes = useRef<Nodes>(new Map());
  // Whether each field is filled and what is wrong with it: never the value, which stays in the field's own node.
  const [states, setStates] = useState<Readonly<Record<string, FieldState>>>({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, boolean>>>({});
  const [submit, setSubmit] = useState(() => defaultSubmit(request));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A send the daemon never answered keeps its id, so pressing Send again cannot type twice.
  const pending = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const many = fields.length !== 1;
  const choices = savedChoices(request);
  const [showOther, setShowOther] = useState(false);

  /** Empties what the card knows of the fields AND the DOM nodes: a typed value is not kept one moment past where it is needed. */
  const clear = useCallback((): void => {
    setStates({});
    setRevealed({});
    for (const node of nodes.current.values()) node.value = '';
  }, []);

  // A page sent to the background drops what was typed (I6): nobody is watching it.
  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clear]);

  const off = blocked !== undefined || sending || busy;
  const ready = typedReady(fields, states);

  /** A send the daemon never answered keeps its id (so pressing again cannot type twice); another choice takes a new one. */
  const deliveryIdFor = (key: string): string => {
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  };

  /** A tap on a saved account: the daemon types from it, so nothing is typed here and nothing is sent but its handle. */
  const tapOffer = async (offer: InputSavedOffer, factor?: string): Promise<void> => {
    if (off) return;
    const built = offerBody(
      request,
      offer,
      submit,
      deliveryIdFor(`offer:${offer.id}:${offer.signIn ?? ''}:${factor ?? ''}`),
      factor,
    );
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    setFailure(null);
    setSending(true);
    onSending(true);
    clear();
    try {
      await deliverInput(client, request, built.body);
      pending.current = null;
      onSettled(offerSentWords(request, offer, factor), offer);
    } catch (cause) {
      const words = inputFailure(cause, request.target.kind);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'changed') onRefresh?.();
    } finally {
      setSending(false);
      onSending(false);
    }
  };

  const send = async (): Promise<void> => {
    if (off) return;
    const deliveryId = deliveryIdFor('typed');
    // Read from the fields once, here, and kept in this call only.
    const values: Record<string, string> = {};
    for (const each of fields) values[each.key] = nodes.current.get(each.key)?.value ?? '';
    const built = typedBody({ request, fields, values, submit, deliveryId });
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    setFailure(null);
    setSending(true);
    onSending(true);
    // To check an answer against: never logged, stored or sent.
    const typed = fields.map(each => values[each.key] ?? '');
    // The body now holds the padded values; the fields do not keep them a moment longer.
    clear();
    try {
      await deliverInput(client, request, built.body);
      pending.current = null;
      onSettled(sentWords(request));
    } catch (cause) {
      const words = inputFailure(cause, request.target.kind, typed);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'changed') onRefresh?.();
    } finally {
      setSending(false);
      onSending(false);
    }
  };

  /** One account: a button per code key when it makes codes here, else the one "use saved" button. */
  const drawOffer = (offer: InputSavedOffer) => {
    const keys = offerCodes(request, offer);
    return keys.length > 0 ? (
      <CodeButtons
        disabled={off}
        key={offer.id + (offer.signIn ?? '')}
        keys={keys}
        offer={offer}
        onUse={factor => void tapOffer(offer, factor)}
      />
    ) : (
      <OfferButton
        disabled={off}
        key={offer.id + (offer.signIn ?? '')}
        offer={offer}
        onUse={() => void tapOffer(offer)}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {choices === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-input-saved="">
          <p className="m-0 text-cell font-medium text-fg">Use a saved login</p>
          {signInNote(request) === undefined ? null : (
            <p className="m-0 text-meta text-muted" data-input-sign-in="">
              {signInNote(request)}
            </p>
          )}
          {differentFromWords(request) === undefined ? null : (
            <p className="m-0 text-meta text-warn" data-input-different="" role="status">
              {differentFromWords(request)}
            </p>
          )}
          {choices.matched.map(drawOffer)}
          {oneFactorLine(request, choices.matched) === undefined ? null : (
            <p className="m-0 text-meta text-warn" data-input-one-factor="" role="note">
              {oneFactorLine(request, choices.matched)}
            </p>
          )}
          {choices.other.length === 0 ? null : (
            <>
              {/* The toggle never moves: the list is drawn BELOW it, so no account is ever drawn under a finger that just tapped it. */}
              <button
                aria-expanded={showOther}
                className="kt-btn min-h-[44px] justify-center"
                data-input-other-toggle=""
                disabled={off}
                onClick={() => setShowOther(current => !current)}
                type="button"
              >
                {showOther ? HIDE_OTHER_ACCOUNTS_WORDS : OTHER_ACCOUNT_WORDS}
              </button>
              {!showOther ? null : (
                <div className="flex min-w-0 flex-col gap-2" data-input-other="">
                  {choices.other.map(drawOffer)}
                </div>
              )}
            </>
          )}
          <p className="m-0 text-meta text-faint">Or type it yourself:</p>
        </div>
      )}
      {/* Outside the form: what a plugin draws here has buttons and fields of its own. */}
      {codesSlot}
      <form
        className="flex min-w-0 flex-col gap-3"
        data-input-form=""
        onSubmit={event => {
          event.preventDefault();
          if (ready) void send();
        }}
      >
        {fields.map(field => (
          <FieldInput
            disabled={off}
            field={field}
            key={field.key}
            many={many}
            nodes={nodes.current}
            onChange={value => setStates(current => ({ ...current, [field.key]: fieldStateOf(field, value) }))}
            onEnter={() => {
              // Enter inside a field sends only when every field is typed.
              if (ready) void send();
            }}
            onReveal={() => setRevealed(current => ({ ...current, [field.key]: !current[field.key] }))}
            problem={many ? states[field.key]?.problem : undefined}
            revealed={revealed[field.key] === true}
          />
        ))}
        {!offersPressEnter(request) ? null : (
          <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
            <input
              checked={submit}
              data-input-enter=""
              onChange={event => setSubmit(event.target.checked)}
              type="checkbox"
            />
            Press Enter for me
          </label>
        )}
        {failure === null ? null : (
          <p className="m-0 text-meta text-err" data-input-failure="" role="alert">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
          {cancel}
          <button
            className="kt-btn min-h-[44px] justify-center"
            data-input-send=""
            data-variant="primary"
            disabled={off || !ready}
            type="submit"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface PasteSectionProps {
  readonly request: InputRequest;
  readonly client: VaultClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  readonly cancel: ReactNode;
  readonly onSettled: (words: string) => void;
  readonly onRefresh?: (() => void) | undefined;
  /** The daemon ended the request for good here: the card's header stops counting down. */
  readonly onEnded: () => void;
  /** A paste from here is on its way (`true`) or came back (`false`). */
  readonly onSending: (sending: boolean) => void;
}

/**
 * A PASTE (docs/secure-copy.md): the ferret asks to paste a secure copy it holds. There is no field: the owner allows it
 * or cancels, and the daemon types the copy the request names. The card shows WHERE the copy was read (the page's own
 * origin or the program that printed it) and WHAT the daemon saw reading the destination, never the value.
 */
function SealedPasteSection({
  request,
  client,
  blocked,
  busy,
  cancel,
  onSettled,
  onRefresh,
  onEnded,
  onSending,
}: PasteSectionProps) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The daemon ended the request for good (a takeover, a copy that is gone): nothing was pasted and nothing can be, so the card
  // settles here and Allow is taken away, whatever the refresh brings.
  const [ended, setEnded] = useState(false);
  // A paste the daemon never answered keeps its id, so pressing Allow again cannot paste twice.
  const pending = useRef<string | null>(null);
  const off = blocked !== undefined || sending || busy || ended;
  const route = pasteRoute(request);
  const size = pasteSize(request);
  const field = pasteField(request);
  const replacing = replacesSecret(request);

  const allow = async (): Promise<void> => {
    if (off) return;
    pending.current ??= crypto.randomUUID();
    const built = sealedBody(request, defaultSubmit(request), pending.current);
    // Unreachable while re-observing (Allow is disabled then), and said in words if it ever is.
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    setFailure(null);
    setSending(true);
    onSending(true);
    try {
      await deliverInput(client, request, built.body);
      pending.current = null;
      onSettled(`Pasted into ${targetRef(request)}.`);
    } catch (cause) {
      const words = inputFailure(cause, request.target.kind);
      if (words.definitive) pending.current = null;
      setFailure(words.text);
      if (words.kind === 'ended' || words.kind === 'gone') {
        setEnded(true);
        onEnded();
      }
      if (words.kind === 'changed' || words.kind === 'ended' || words.kind === 'gone') onRefresh?.();
    } finally {
      setSending(false);
      onSending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-input-paste="">
      <dl
        className="m-0 grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-panel border border-border-strong bg-surface-2 p-panel text-ui"
        data-input-paste-route=""
      >
        <dt className="text-faint">Copy</dt>
        <dd className="m-0 min-w-0 break-words mono text-fg" data-input-paste-copy="">
          {pastedWords(request)}
        </dd>
        {size === undefined ? null : (
          <>
            <dt className="text-faint">Size</dt>
            <dd className="m-0 min-w-0 break-words text-fg" data-input-paste-size="">
              {size}
            </dd>
          </>
        )}
        <dt className="text-faint">From</dt>
        <dd className="m-0 min-w-0 break-words text-fg" data-input-paste-from="">
          {/* A path from the ferret's own files: isolated, so a right-to-left folder name cannot reorder it. */}
          <bdi dir="ltr">{route?.from}</bdi>
        </dd>
        <dt className="text-faint">Into</dt>
        <dd className="m-0 min-w-0 break-words font-medium text-fg" data-input-paste-to="">
          {route?.to}
        </dd>
        {field === undefined ? null : (
          <>
            <dt className="text-faint">Field</dt>
            <dd className="m-0 min-w-0 break-words text-fg" data-input-paste-field="">
              {field}
            </dd>
          </>
        )}
      </dl>
      <p className="m-0 text-meta text-faint">
        You type nothing: Ferretry pastes the sealed value, which the ferret never sees.
      </p>
      {failure === null ? null : (
        <p className="m-0 text-ui text-err" data-input-failure="" role="alert">
          {failure}
        </p>
      )}
      {ended ? (
        <p className="m-0 text-ui font-semibold text-fg" data-input-ended="" role="status">
          This paste has ended. Nothing was pasted.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
        {ended ? null : cancel}
        {ended ? null : (
          <button
            className="kt-btn min-h-[44px]"
            data-input-allow=""
            data-variant={replacing ? 'danger' : 'primary'}
            disabled={off}
            onClick={() => void allow()}
            type="button"
          >
            {sending ? (replacing ? 'Replacing…' : 'Pasting…') : allowWords(request)}
          </button>
        )}
      </div>
    </div>
  );
}

export function InputCard({
  request,
  client,
  agentName = 'The ferret',
  now: fixedNow,
  onDone,
  onRefresh,
  onHold,
  embedded = false,
}: InputCardProps) {
  const headingId = useId();
  const now = useNow(fixedNow);
  const fields = fieldsOf(request);
  const [settled, setSettled] = useState<string | null>(null);
  // The saved account the owner tapped, once the card settled on it: the slot after the card is offered for it.
  const [used, setUsed] = useState<InputSavedOffer | null>(null);
  // The paste section ended the request (a takeover, a gone copy) before the refreshed request arrived.
  const [pasteEnded, setPasteEnded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A panel in a slot of the card is still offering something: the card keeps the view while it does.
  const [codesHold, setCodesHold] = useState(false);
  const [settledHold, setSettledHold] = useState(false);
  const refreshing = useRef(onRefresh);
  refreshing.current = onRefresh;
  const refresh = useCallback((): void => refreshing.current?.(), []);
  const holding = sending || cancelling || (settled === null && codesHold) || (settled !== null && settledHold);
  const told = useRef<string | null>(null);
  const hold = useRef(onHold);
  hold.current = onHold;
  useEffect(() => {
    const said = `${holding}\u0000${settled ?? ''}`;
    if (told.current === said || (told.current === null && !holding && settled === null)) return;
    told.current = said;
    hold.current?.(holding, holding || settled === null ? undefined : settled);
  }, [holding, settled]);

  const blocked = sendBlock(request, now);
  const facts = factsOf(request);
  const title = titleWords(request, agentName);

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

  return (
    <section
      {...(embedded ? { 'aria-label': title } : { 'aria-labelledby': headingId })}
      className={`${INPUT_CLASS} flex min-w-0 flex-col gap-3${embedded ? '' : ' kt-panel p-panel'}`}
      data-input-embedded={embedded ? '' : undefined}
      data-input-request={request.id}
      data-input-state={settled === null ? request.state : 'settled'}
    >
      <header className="flex items-baseline gap-x-2">
        {/* The title and the target wrap among themselves; the time left keeps its own column, never a line of its own. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
          {embedded ? null : (
            <h3 className="m-0 min-w-0 text-row font-semibold text-fg" data-input-title="" id={headingId}>
              {title}
            </h3>
          )}
          <p className="m-0 text-cell text-muted">
            Goes to{' '}
            <code className="mono text-fg" data-input-target="">
              {targetRef(request)}
            </code>
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap text-meta text-faint" data-input-expiry="">
          {/* No time left to count once the request is over, however it ended and before any refresh says so. */}
          {settled !== null || pasteEnded || (request.state !== 'pending' && request.state !== 'delivering')
            ? request.state === 'expired'
              ? 'expired'
              : 'ended'
            : expiryWords(request.expiresAt, now)}
        </span>
      </header>

      <div
        className="flex min-w-0 flex-col gap-1 rounded-panel border border-border-strong bg-surface-2 p-panel"
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
              {facts.verb}
              {facts.echo === undefined ? null : (
                <span className="font-normal text-muted" data-input-echo="">
                  {' '}
                  · {facts.echo}
                </span>
              )}
            </p>
            {facts.promptLine === undefined ? null : (
              <code className="mono block min-w-0 break-words text-cell text-fg" data-input-prompt-line="">
                {facts.promptLine}
              </code>
            )}
          </>
        )}
        {facts?.promptLine !== undefined && facts.promptLine.trim() === request.prompt.trim() ? null : (
          <p className="m-0 text-meta text-faint" data-input-agent-says="">
            {agentName} says: “{request.prompt}”
          </p>
        )}
      </div>

      {[
        ...new Map(
          [request.risk, ...(request.risks ?? [])].filter(risk => risk !== undefined).map(risk => [risk.reason, risk]),
        ).values(),
      ].map(risk =>
        risk === undefined ||
        // A paste card says "you type nothing" once, below: the generic green hidden-typing line is not repeated on it.
        (request.source !== undefined && risk.level === 'green') ? null : replacesSecret(request) ? (
          // Overwriting a secret cannot be undone: said loudly, in its own box, and the approval below is a destructive one.
          <div
            className="flex gap-2 rounded-panel border border-err bg-surface-2 p-panel text-ui font-semibold text-err"
            key={risk.reason}
            data-input-replace=""
            data-input-risk={risk.level}
            role="alert"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
            <span>{risk.reason}</span>
          </div>
        ) : risk.level === 'amber' ? (
          // The daemon could not promise the value was never seen: a warning the owner must be able to notice, never footer help.
          <div
            className="flex gap-2 rounded-panel border border-warn bg-warn/10 p-panel text-ui font-semibold text-fg"
            data-input-risk={risk.level}
            key={risk.reason}
            data-input-warning=""
            role="status"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0 text-warn" size={16} />
            <span>{risk.reason}</span>
          </div>
        ) : (
          <p
            key={risk.reason}
            className={`m-0 text-cell ${risk.level === 'red' ? 'text-err font-semibold' : 'text-muted'}`}
            data-input-risk={risk.level}
          >
            {risk.reason}
          </p>
        ),
      )}
      {settled !== null ? (
        <>
          <p className="m-0 text-ui text-fg" data-input-settled="" role="status">
            {settled}
          </p>
          {used === null ? null : <SettledSlot hold={setSettledHold} slot={settledSlotProps(request, used)} />}
        </>
      ) : request.source !== undefined ? (
        // A paste of a secure copy has nothing to type: the owner allows it, and the daemon pastes what the request names.
        <>
          {blocked !== undefined && facts !== undefined ? (
            <p className="m-0 text-meta text-warn" data-input-blocked="" role="status">
              {blocked}
            </p>
          ) : null}
          <SealedPasteSection
            blocked={blocked}
            busy={cancelling}
            cancel={cancelButton}
            client={client}
            onEnded={() => setPasteEnded(true)}
            onRefresh={onRefresh}
            onSending={setSending}
            onSettled={words => {
              setSettled(words);
              onDone();
            }}
            request={request}
          />
          {problem === null ? null : (
            <p className="m-0 text-meta text-err" data-input-cancel-failure="" role="alert">
              {problem}
            </p>
          )}
        </>
      ) : (
        <>
          {blocked !== undefined && facts !== undefined ? (
            <p className="m-0 text-meta text-warn" data-input-blocked="" role="status">
              {blocked}
            </p>
          ) : null}
          {request.pictured === true && request.target.kind === 'page' ? (
            <FieldShot client={client} fields={fields} request={request} />
          ) : null}
          <InputForm
            blocked={blocked}
            busy={cancelling}
            cancel={cancelButton}
            client={client}
            fields={fields}
            onRefresh={onRefresh}
            onSending={setSending}
            onSettled={(words, offer) => {
              setSettled(words);
              setUsed(offer ?? null);
              onDone();
            }}
            request={request}
            {...(offersCodesSlot(request) && request.saved !== undefined
              ? {
                  codesSlot: (
                    <CodesSlot
                      slot={{
                        requestId: request.id,
                        ferretId: request.sessionId,
                        saved: request.saved,
                        refresh,
                        hold: setCodesHold,
                      }}
                    />
                  ),
                }
              : {})}
          />
          {problem === null ? null : (
            <p className="m-0 text-meta text-err" data-input-cancel-failure="" role="alert">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  );
}
