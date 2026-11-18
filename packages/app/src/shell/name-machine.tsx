import { MachineNameSchema } from '@ferretry/kernel/contract';
import { useEffect, useRef, useState } from 'react';
import type { ShellPluginClient } from '../client/daemon-client.ts';
import { daemonTitle } from '../daemons/daemon-list.ts';
import { useRuntimeVersion, useShell } from './context.tsx';

/**
 * "NAME THIS MACHINE": the short step a pairing offers when the machine it paired with has no name of the owner's.
 *
 * Without one a machine goes by its host name (`ip-172-27-76-90`), and that is what every list and the machine picker
 * would show. The step asks what to call it, prefilled with the host name, and may be skipped. It writes through the
 * EXISTING name route (`PUT /v1/config/file` on `host.yaml`, the file Settings › General › Name edits), so the daemon
 * governs it exactly as it governs that tab: a device without the configure grant is refused, the step says so in the
 * daemon's own words, and moves on. Nothing here decides who may rename a machine.
 *
 * It is only offered by a pairing (`PairingInput.askName`), once per pairing and never again after a reload, and it
 * stays out of the way when it cannot tell whether the machine is named (the read was refused or failed).
 */

const HOST_FILE = 'host.yaml';
const NAME_LINE = /^name:/mu;

/** Whether the machine's owner has named it (a `name` in `host.yaml`); without one it goes by its host name. */
export const hostFileIsNamed = (file: { readonly exists: boolean; readonly text: string }): boolean =>
  file.exists && NAME_LINE.test(file.text);

/** The text a name is saved as: a JSON string is a valid YAML scalar, so no character needs its own escaping. */
const hostFileText = (name: string): string => `name: ${JSON.stringify(name)}\n`;

export interface HostFile {
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}

export const readHostFile = async (client: ShellPluginClient, quiet = false): Promise<HostFile> => {
  // `quiet`: a read the machine switcher makes by itself on a page load, which must never raise a passkey prompt; a refusal is the answer.
  const answer = (await client.call('GET /v1/config/file', {
    query: { path: HOST_FILE },
    ...(quiet ? { quiet: true } : {}),
  })) as Partial<HostFile> | null;
  if (answer === null || typeof answer.etag !== 'string') throw new Error('unreadable');
  return {
    exists: answer.exists === true,
    text: typeof answer.text === 'string' ? answer.text : '',
    etag: answer.etag,
  };
};

const sentenceOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

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
            <button type="submit" className="kt-btn" data-variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save name'}
            </button>
            <button type="button" className="kt-btn" disabled={busy} data-name-machine-skip="" onClick={onSkip}>
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
          <button type="button" className="kt-btn self-start" data-name-machine-skip="" onClick={onSkip}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

/** The step for one machine just paired with: asks it whether it has a name, and offers one only when it has none. */
export function NameThisMachine({ daemon }: { readonly daemon: string }) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const client = runtime.client(daemon, 'kernel');
  const paired = runtime.daemons.get(daemon);
  const [file, setFile] = useState<HostFile | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const settle = (): void => runtime.daemons.nameSettled(daemon);
  const asked = useRef(false);
  useEffect(() => {
    // One look per mount, once the machine can be asked. A machine that cannot say is left alone.
    if (client === undefined || asked.current) return;
    asked.current = true;
    void readHostFile(client).then(
      read => (hostFileIsNamed(read) ? runtime.daemons.nameSettled(daemon) : setFile(read)),
      () => runtime.daemons.nameSettled(daemon),
    );
  }, [client, daemon, runtime]);
  if (file === undefined || client === undefined || paired === undefined) return null;
  const save = async (typed: string): Promise<void> => {
    const parsed = MachineNameSchema.safeParse(typed);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'That name cannot be used.');
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      await client.call('PUT /v1/config/file', {
        body: { path: HOST_FILE, text: hostFileText(parsed.data), etag: file.etag },
      });
      runtime.daemons.learnMachine(daemon, parsed.data);
      settle();
    } catch (cause) {
      setBusy(false);
      setRefusal(sentenceOf(cause));
    }
  };
  return (
    <NameThisMachineView
      initial={daemonTitle(paired)}
      busy={busy}
      {...(refusal === undefined ? {} : { refusal })}
      {...(problem === undefined ? {} : { problem })}
      onSave={name => void save(name)}
      onSkip={settle}
    />
  );
}
