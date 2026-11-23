/**
 * "WHICH AI DO YOU WANT TO USE?" (the first page of setup). A short checklist: Claude (ticked), Codex, Gemini (shown, "Coming"), and
 * Others, which opens the providers the CATALOG lists; each ticked provider then asks "Which harness runs it?" with only the
 * supported harnesses that can run it. Choosing writes nothing: a tick is memory of this run (the flow hides the pages of every
 * harness that was not picked), and the footer's Next answers the page. The page draws no title, progress or footer: the flow owns them.
 */
import type { StepHost } from '@ferretry/kernel/contract';
import { Badge } from '@ferretry/app';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AI_CHOICES,
  type Found,
  type Pick,
  type Provider,
  SUPPORTED_HARNESSES,
  isEmptyPick,
  memoryOfPick,
  pickFromMemory,
  withHarness,
  withProvider,
} from './agents-model.ts';

const ROW =
  'kt-panel flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 p-panel hover:border-accent has-[input:disabled]:cursor-default has-[input:disabled]:opacity-80 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus';
const BOX = 'mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]';

/** What the catalog read came to: still reading, failed, or the providers. */
type ProviderRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly providers: readonly Provider[] };

const harnessLabel = (key: string): string => SUPPORTED_HARNESSES.find(harness => harness.plugin === key)?.label ?? key;

function Row({
  label,
  line,
  checked,
  disabled,
  badge,
  found,
  onChange,
  children,
  name,
}: {
  readonly label: string;
  readonly line: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly badge?: string;
  /** What was found on this computer for this row (the scan read it; nothing is written). */
  readonly found?: Found;
  readonly onChange: (on: boolean) => void;
  readonly children?: ReactNode;
  readonly name: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2" data-agent-row={name}>
      <label htmlFor={id} className={ROW}>
        <input
          id={id}
          type="checkbox"
          className={BOX}
          checked={checked}
          disabled={disabled === true}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="inline-flex flex-wrap items-center gap-2 text-row font-semibold text-fg">
            {label}
            {badge === undefined ? null : <Badge data-agent-coming="">{badge}</Badge>}
            {found === undefined ? null : (
              <Badge tone="ok" data-agent-found="">
                Found on this computer
              </Badge>
            )}
          </span>
          <span className="text-cell text-muted">
            {found?.ready === true ? `${line} Your setup on this computer is ready to bring over.` : line}
          </span>
        </span>
      </label>
      {children}
    </div>
  );
}

/** One ticked provider's "Which harness runs it?". */
function HarnessChoice({
  provider,
  harness,
  onChoose,
}: {
  readonly provider: Provider;
  readonly harness: string | undefined;
  readonly onChoose: (key: string) => void;
}): ReactNode {
  const group = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0 pl-4" data-agent-harness={provider.id}>
      <legend className="mb-1 p-0 text-cell font-semibold text-fg">Which harness runs it?</legend>
      {provider.harnesses.map(key => (
        <label key={key} className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={group}
            value={key}
            className="h-4 w-4 accent-[var(--accent)]"
            checked={harness === key}
            onChange={() => onChoose(key)}
          />
          {harnessLabel(key)}
        </label>
      ))}
    </fieldset>
  );
}

/** The page over the pick and the catalog read it is handed (the real page hands the run's). */
function AgentsChoices({
  pick,
  onPick,
  read,
  onRetry,
  found,
}: {
  readonly pick: Pick;
  readonly onPick: (next: Pick) => void;
  readonly read: ProviderRead;
  readonly onRetry: () => void;
  readonly found: Readonly<Record<string, Found>>;
}): ReactNode {
  const [othersOpen, setOthersOpen] = useState(() => Object.keys(pick.others).length > 0);
  const listed = AI_CHOICES;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="agents">
      {listed.map(choice => (
        <Row
          key={choice.id}
          name={choice.id}
          label={choice.title}
          line={choice.line}
          checked={choice.id === 'gemini' ? false : pick[choice.id]}
          disabled={choice.coming !== undefined}
          {...(choice.coming === undefined ? {} : { badge: choice.coming })}
          {...(found[choice.id] === undefined ? {} : { found: found[choice.id] as Found })}
          onChange={on => (choice.id === 'gemini' ? undefined : onPick({ ...pick, [choice.id]: on }))}
        />
      ))}
      <Row
        name="others"
        label="Others"
        line="Kimi, GLM, DeepSeek, Ollama and more, run by a harness we support."
        checked={othersOpen}
        onChange={on => {
          setOthersOpen(on);
          if (!on) onPick({ ...pick, others: {} });
        }}
      >
        {othersOpen ? (
          <div className="flex min-w-0 flex-col gap-2 border-l-2 border-border-soft pl-4" data-agent-providers="">
            {read.kind === 'reading' ? (
              <p className="m-0 text-cell text-muted" role="status" data-agent-providers-reading="">
                Looking at the providers this machine offers…
              </p>
            ) : read.kind === 'failed' ? (
              <p className="m-0 text-cell text-warn" role="alert" data-agent-providers-failed="">
                Could not read the provider list.{' '}
                <button type="button" className="underline" onClick={onRetry}>
                  Try again
                </button>
              </p>
            ) : (
              read.providers.map(provider => (
                <Row
                  key={provider.id}
                  name={`provider-${provider.id}`}
                  label={provider.label}
                  line={`Runs in ${provider.harnesses.map(harnessLabel).join(' or ')}.`}
                  checked={pick.others[provider.id] !== undefined}
                  onChange={on => onPick(withProvider(pick, provider, on))}
                >
                  {pick.others[provider.id] === undefined ? null : (
                    <HarnessChoice
                      provider={provider}
                      harness={pick.others[provider.id]}
                      onChoose={key => onPick(withHarness(pick, provider, key))}
                    />
                  )}
                </Row>
              ))
            )}
          </div>
        ) : null}
      </Row>
    </div>
  );
}

const NO_PROVIDERS: readonly Provider[] = [];
const NO_FOUND: Readonly<Record<string, Found>> = {};

/** The real page: reads the catalog once (a retry reads again), and keeps the pick in the run's memory. */
export function AgentsPage({
  step,
  readProviders,
  found = NO_FOUND,
}: {
  readonly step: StepHost | undefined;
  readonly readProviders: () => Promise<readonly Provider[]>;
  /** The harnesses found on this computer, by catalog key (claude, codex). */
  readonly found?: Readonly<Record<string, Found>>;
}): ReactNode {
  const [pick, setPick] = useState<Pick>(() => pickFromMemory(step?.segment ?? {}));
  const [read, setRead] = useState<ProviderRead>({ kind: 'reading' });
  const host = useRef(step);
  host.current = step;
  const providers = read.kind === 'ready' ? read.providers : NO_PROVIDERS;
  const look = useRef(readProviders);
  look.current = readProviders;
  const load = useCallback((): void => {
    setRead({ kind: 'reading' });
    look.current().then(
      list => setRead({ kind: 'ready', providers: list }),
      () => setRead({ kind: 'failed' }),
    );
  }, []);
  // The page draws at once: the catalog is read beside it, and only the Others list waits for it.
  useEffect(() => {
    host.current?.ready();
    load();
  }, [load]);
  // The run's memory follows the pick (the flow hides the pages of every harness left out); nothing is written.
  useEffect(() => {
    host.current?.remember(memoryOfPick(pick, providers));
  }, [pick, providers]);
  // Next needs at least one AI: an empty pick would skip both harnesses without a word. Later (which never runs this) is the
  // plain way to leave the question for another time.
  const empty = isEmptyPick(pick, providers);
  const holding = useRef(false);
  useEffect(() => {
    if (!empty && !holding.current) return;
    holding.current = empty;
    host.current?.commit(
      empty
        ? async () => {
            throw new Error('Pick at least one AI to set up, or choose Later.');
          }
        : null,
    );
  }, [empty]);
  return (
    <>
      <AgentsChoices pick={pick} onPick={setPick} read={read} onRetry={load} found={found} />
      {empty ? (
        <p className="m-0 mt-3 text-cell text-muted" role="status" data-agent-none="">
          Pick at least one AI to set up, or choose Later.
        </p>
      ) : null}
    </>
  );
}
