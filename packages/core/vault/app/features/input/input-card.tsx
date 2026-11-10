/**
 * THE INPUT CARD — an agent is stuck at a password, `sudo`, one-time-code or 2FA prompt and only the owner knows the
 * value (docs/input-requests.md, "The agenda card").
 *
 * WHAT THE CARD SHOWS, top to bottom: who needs what and where, what the DAEMON saw at that target (drawn large: the
 * program, whether typing is hidden, the prompt line), the ferret's own words small (they are a claim, not evidence),
 * the risk flag, then the way in: one masked field per value, each with a local eye that is not remembered, and "Press
 * Enter for me".
 *
 * THE VALUES LIVE ONLY IN THE CONTROLLED FIELDS until Send (I6). They are never put in a draft store, storage, a query
 * cache, a URL or a log; every field is cleared on Send, when the card unmounts and when the page is hidden.
 *
 * ENTER (I51): the tick starts on for an owner default and for a terminal secret, off for a browser page; the
 * agent presses it itself when it said so, and then there is no tick at all.
 */
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cancelInput, deliverInput } from '../../lib/input-api.ts';
import {
  defaultSubmit,
  expiryWords,
  fieldAttributes,
  fieldProblem,
  fieldsOf,
  type InputCardField,
  inputFailure,
  offersPressEnter,
  plainFlagWords,
  revealable,
  sendBlock,
  sentWords,
  targetRef,
  titleWords,
  typedBody,
  typedReady,
} from '../../lib/input-card.ts';
import type { InputRequestView } from '../../lib/input-wire.ts';
import { Eye, EyeOff, ShieldAlert, type VaultClient } from '../../shell.tsx';

export interface InputCardProps {
  readonly request: InputRequestView;
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
  request: InputRequestView,
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
  readonly value: string;
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly many: boolean;
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onReveal: () => void;
  readonly onEnter: () => void;
}

function FieldInput({
  field,
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
  readonly request: InputRequestView;
  readonly fields: readonly InputCardField[];
  readonly client: VaultClient;
  readonly blocked: string | undefined;
  readonly busy: boolean;
  readonly cancel: ReactNode;
  readonly onSettled: (words: string) => void;
  readonly onSending: (sending: boolean) => void;
  readonly onRefresh?: (() => void) | undefined;
}

function InputForm({ request, fields, client, blocked, busy, cancel, onSettled, onSending, onRefresh }: FormProps) {
  const nodes = useRef<Nodes>(new Map());
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, boolean>>>({});
  const [submit, setSubmit] = useState(() => defaultSubmit(request));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A send the daemon never answered keeps its id, so pressing Send again cannot type twice.
  const pending = useRef<string | null>(null);
  const many = fields.length !== 1;

  /** Empties the controlled state AND the DOM nodes: a typed value is not kept one moment past where it is needed. */
  const clear = useCallback((): void => {
    setValues({});
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
  const ready = typedReady(fields, values);

  const send = async (): Promise<void> => {
    if (off) return;
    pending.current ??= crypto.randomUUID();
    const built = typedBody({ request, fields, values, submit, deliveryId: pending.current });
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    setFailure(null);
    setSending(true);
    onSending(true);
    // Kept in this call only, to check an answer against: never logged, stored or sent.
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

  return (
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
          onChange={value => setValues(current => ({ ...current, [field.key]: value }))}
          onEnter={() => {
            // Enter inside a field sends only when every field is typed.
            if (ready) void send();
          }}
          onReveal={() => setRevealed(current => ({ ...current, [field.key]: !current[field.key] }))}
          problem={many ? fieldProblem(field, values[field.key] ?? '') : undefined}
          revealed={revealed[field.key] === true}
          value={values[field.key] ?? ''}
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
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const holding = sending || cancelling;
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
      className={`fy-input-card flex min-w-0 flex-col gap-3${embedded ? '' : ' kt-panel p-panel'}`}
      data-input-embedded={embedded ? '' : undefined}
      data-input-request={request.id}
      data-input-state={settled === null ? request.state : 'settled'}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
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
        <span className="ml-auto whitespace-nowrap text-meta text-faint" data-input-expiry="">
          {expiryWords(request.expiresAt, now)}
        </span>
      </header>

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

      {request.risk === undefined ? null : (
        <p className="m-0 text-cell text-muted" data-input-risk={request.risk.level}>
          {request.risk.reason}
        </p>
      )}
      {request.lock === undefined ? null : (
        <p className="m-0 text-meta text-muted" data-input-lock="">
          Hidden from the ferret for{' '}
          {request.lock.seconds >= 60 ? `${Math.round(request.lock.seconds / 60)} min` : `${request.lock.seconds} s`}{' '}
          after you type.
        </p>
      )}

      {settled !== null ? (
        <p className="m-0 text-ui text-fg" data-input-settled="" role="status">
          {settled}
        </p>
      ) : request.source !== undefined ? (
        // A paste of a secure copy has nothing to type; approving one is Accounts' card, not drawn here. No field.
        <>
          <p className="m-0 text-ui text-muted" data-input-paste="" role="status">
            This request pastes a secure copy, so there is nothing to type. Answer it with fy, or cancel it.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2" data-input-actions="">
            {cancelButton}
          </div>
        </>
      ) : (
        <>
          {blocked !== undefined && facts !== undefined ? (
            <p className="m-0 text-meta text-warn" data-input-blocked="" role="status">
              {blocked}
            </p>
          ) : null}
          <InputForm
            blocked={blocked}
            busy={cancelling}
            cancel={cancelButton}
            client={client}
            fields={fields}
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
      )}
    </section>
  );
}
