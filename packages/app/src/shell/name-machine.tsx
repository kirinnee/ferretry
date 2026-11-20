import { MachineNameSchema } from '@ferretry/kernel/contract';
import { useEffect, useRef, useState } from 'react';
import { daemonTitle } from '../daemons/daemon-list.ts';
import { useRuntimeVersion, useShell } from './context.tsx';
import { hostFileIsNamed, readHostFile, sentenceOf, writeMachineName } from './machine-name-file.ts';

export { hostFileIsNamed, readHostFile } from './machine-name-file.ts';

/**
 * "NAME THIS MACHINE": the short step a pairing offers when the machine it paired with has no name of the owner's.
 *
 * Without one a machine goes by its host name (`ip-172-27-76-90`), and that is what every list and the machine picker
 * would show. The step asks what to call it, prefilled with the host name, and may be skipped. It writes through the
 * EXISTING name route (`PUT /v1/config/file` on `host.yaml`, the file Settings › General › Name edits), so the daemon
 * governs it exactly as it governs that tab: a device without the configure grant is refused, the step says so in the
 * daemon's own words, and moves on. Nothing here decides who may rename a machine.
 *
 * A name the person already typed ON THE PAIR SCREEN is saved first, through the same call, and then this step never
 * shows. Only when that save fails does the step come back, prefilled with the typed name, and says what went wrong.
 *
 * It is only offered by a pairing (`PairingInput.askName`), once per pairing and never again after a reload, and it
 * stays out of the way when it cannot tell whether the machine is named (the read was refused or failed).
 */

/** What the step decided, for a host that draws it as one page of a flow: it is asking, the machine already has a name of its own, or the person answered (saved or skipped). */
export type NameDecision = 'asking' | 'named' | 'settled';

interface NameThisMachineViewProps {
  /** The host name the field starts with. */
  readonly initial: string;
  readonly busy: boolean;
  /** Why the daemon refused, once it did: the step then only offers to go on. */
  readonly refusal?: string;
  /** A name the daemon would not take, before anything was sent. */
  readonly problem?: string;
  readonly onSave: (name: string) => void;
  readonly onSkip: () => void;
}

/** The step, drawn from plain values so every state can be rendered without a daemon. */
function NameThisMachineView({ initial, busy, refusal, problem, onSave, onSkip }: NameThisMachineViewProps) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (refusal === undefined) field.current?.focus();
  }, [refusal]);
  return (
    <section className="kt-panel p-panel m-3" aria-labelledby="name-machine-heading" data-name-machine="">
      <h3 id="name-machine-heading" className="m-0 text-row font-semibold text-fg">
        Name this machine
      </h3>
      {refusal === undefined ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            onSave(value);
          }}
        >
          <p className="m-0 text-cell leading-base text-muted">
            It goes by its host name now. Pick a name you will know it by; every device will show it.
          </p>
          <label htmlFor="name-machine-field" className="text-cell font-semibold text-fg">
            Machine name
          </label>
          <input
            id="name-machine-field"
            ref={field}
            className="min-h-[44px] rounded-control border border-border-strong bg-surface-2 px-control-x text-row text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
            value={value}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem === undefined ? undefined : true}
            onChange={event => setValue(event.target.value)}
          />
          {problem === undefined ? null : (
            <p role="alert" className="m-0 text-meta font-semibold text-err">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="kt-btn min-h-[44px]" data-variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save name'}
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={busy}
              data-name-machine-skip=""
              onClick={onSkip}
            >
              Not now
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <p role="alert" className="m-0 text-cell leading-base text-fg" data-name-machine-refused="">
            This device cannot name this machine: {refusal}
          </p>
          <p className="m-0 text-meta leading-base text-faint">
            It keeps its host name. Name it later in Settings › General › Name, from a device that may.
          </p>
          <button type="button" className="kt-btn min-h-[44px] self-start" data-name-machine-skip="" onClick={onSkip}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The step for one machine just paired with: asks it whether it has a name, and offers one only when it has none. A
 * name typed on the pair screen is saved by {@link ChosenNameSaver}, not here: while that save is waiting or running
 * this draws nothing, and only when it failed does the step come back, with the typed name and the reason.
 */
export function NameThisMachine({
  daemon,
  onDecided,
  onBusy,
}: {
  readonly daemon: string;
  readonly onDecided?: (decision: NameDecision) => void;
  /** A host that draws the step as one page of a flow learns when a save is running (so it can lock its own footer). */
  readonly onBusy?: (busy: boolean) => void;
}) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const client = runtime.client(daemon, 'kernel');
  const paired = runtime.daemons.get(daemon);
  const chosen = runtime.daemons.chosenName(daemon);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  // The host's callback is read when it is called, so a new function each render never restarts the look below.
  const decided = useRef(onDecided);
  decided.current = onDecided;
  const working = useRef(onBusy);
  working.current = onBusy;
  useEffect(() => {
    working.current?.(busy);
  }, [busy]);
  const settle = (): void => {
    runtime.daemons.nameSettled(daemon);
    decided.current?.('settled');
  };
  const asked = useRef(false);
  const chosenAtPairing = chosen !== undefined;
  useEffect(() => {
    // One look per mount, once the machine can be asked. A machine that cannot say is left alone.
    if (client === undefined || asked.current || chosenAtPairing) return;
    asked.current = true;
    void readHostFile(client).then(
      read => {
        if (!hostFileIsNamed(read)) return setReady(true);
        runtime.daemons.nameSettled(daemon);
        decided.current?.('named');
      },
      () => {
        runtime.daemons.nameSettled(daemon);
        decided.current?.('named');
      },
    );
  }, [client, daemon, runtime, chosenAtPairing]);
  const shown =
    client !== undefined && paired !== undefined && (chosen === undefined ? ready : chosen.state === 'failed');
  useEffect(() => {
    if (shown) decided.current?.('asking');
  }, [shown]);
  if (client === undefined || paired === undefined) return null;
  if (chosen === undefined ? !ready : chosen.state !== 'failed') return null;
  const save = async (typed: string): Promise<void> => {
    const parsed = MachineNameSchema.safeParse(typed);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'That name cannot be used.');
      return;
    }
    setProblem(undefined);
    setBusy(true);
    // The revision is read now, never kept from an earlier look: a read that failed before must not poison this save.
    let etag: string;
    try {
      etag = (await readHostFile(client)).etag;
    } catch (cause) {
      setBusy(false);
      setProblem(`This machine's current name could not be read: ${sentenceOf(cause)}`);
      return;
    }
    try {
      await writeMachineName(client, parsed.data, etag);
      runtime.daemons.learnMachine(daemon, parsed.data);
      settle();
    } catch (cause) {
      setBusy(false);
      setRefusal(sentenceOf(cause));
    }
  };
  return (
    <NameThisMachineView
      initial={chosen?.name ?? daemonTitle(paired)}
      busy={busy}
      {...(refusal === undefined ? {} : { refusal })}
      {...(problem === undefined && chosen?.problem === undefined ? {} : { problem: problem ?? chosen?.problem })}
      onSave={name => void save(name)}
      onSkip={settle}
    />
  );
}
