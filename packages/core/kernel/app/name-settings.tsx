/**
 * SETTINGS › GENERAL › NAME: what this machine is called, on every device. One field over `config/host.yaml`; empty
 * returns to the host name. The same `MachineNameSchema` the daemon checks with, so the sentence a person reads here is
 * the one the daemon would refuse with. The write goes through the ordinary configuration-file routes (Gate admits it
 * as it does any file), and the daemon tells every open app, which re-reads the name.
 */
import { useCallback, useEffect, useState } from 'react';
import { MachineNameSchema } from '../contract/kernel.ts';
import { readConfigFile, reasonOf, writeConfigFile } from './config-files/api.ts';
import { callFailure, type KernelClient } from './lib/client.ts';

const HOST_FILE = 'host.yaml';
const NAME_LINE = /^name:/mu;

interface Reading {
  /** The name every device shows now. */
  readonly name: string;
  /** Whether it is the owner's (a `name` in `host.yaml`) or the host name. */
  readonly source: 'owner' | 'hostname';
  readonly etag: string;
}

/** The text a name is saved as: a JSON string is a valid YAML scalar, so no character needs its own escaping. */
export const hostFileText = (name: string): string => `name: ${JSON.stringify(name)}\n`;

async function read(client: KernelClient, pressed: boolean): Promise<Reading> {
  const [file, inventory] = await Promise.all([
    readConfigFile(client, HOST_FILE, pressed),
    client.call('GET /v1/plugins', pressed ? { quiet: false } : {}) as Promise<{ readonly daemonName?: string }>,
  ]);
  return {
    name: inventory.daemonName ?? '',
    source: file.exists && NAME_LINE.test(file.text) ? 'owner' : 'hostname',
    etag: file.etag,
  };
}

/**
 * The press a refused first read offers (A555 r7): named for the passkey the machine wants, like the shell's strip.
 * Pressing it reads again as the person's own act, so the ONE passkey prompt opens ("Add a passkey" for a device with
 * none); any other failure is a plain Try again.
 */
const retryLabel = (cause: unknown): string => {
  const code = callFailure(cause)?.code;
  if (code === 'unlock_required') return 'Unlock';
  if (code === 'grant_step_up_required') return 'Confirm it’s you';
  return 'Try again';
};

/**
 * The line under the field. A machine that did not report its name (the inventory's `daemonName` is optional, and the app
 * reads it before the daemon has answered) is told in words, never as "Shown now: ." with nothing after it.
 */
export function noteOf(source: 'owner' | 'hostname', current: string): string {
  if (source === 'owner')
    return current === ''
      ? 'No name is showing yet: this machine has not reported one. Leave the field empty to go back to the host name.'
      : `Shown now: ${current}. Leave it empty to go back to the host name.`;
  return current === ''
    ? 'This machine is using its host name. Type a name to replace it.'
    : `Using the host name (${current}). Type a name to replace it.`;
}

/** The tab, drawn from plain values so every state can be rendered without a daemon. */
export function NameSettingsView({
  current,
  source,
  value,
  onChange,
  onSave,
  busy,
  problem,
  saved,
  reading = false,
  retry,
}: {
  readonly current: string;
  readonly source: 'owner' | 'hostname';
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
  readonly busy: boolean;
  readonly problem?: string;
  readonly saved: boolean;
  /** The name is still being read: nothing to save yet (never "Saving…", A555 r7). */
  readonly reading?: boolean;
  /** The first read was refused: one press that reads again as the person's own. */
  readonly retry?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <section className="kt-panel kt-panel--flat py-panel" aria-label="Name" data-machine-name="">
      <p className="m-0 text-cell leading-base text-muted">
        What this machine is called on every device: the pair screen, the machine list and notifications.
      </p>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault();
          onSave();
        }}
      >
        <label htmlFor="settings-machine-name" className="text-cell font-semibold text-fg">
          Machine name
        </label>
        <input
          id="settings-machine-name"
          className="min-h-[44px] w-full max-w-[28rem] rounded-control border border-border-strong bg-surface-2 px-control-x text-row text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
          value={value}
          maxLength={100}
          placeholder={source === 'hostname' && current !== '' ? current : 'Leave empty to use the host name'}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby="settings-machine-name-note"
          onChange={event => onChange(event.target.value)}
        />
        <p id="settings-machine-name-note" className="m-0 text-meta leading-base text-faint">
          {noteOf(source, current)}
        </p>
        {problem === undefined ? null : (
          <p role="alert" className="m-0 text-meta font-semibold text-err">
            {problem}
          </p>
        )}
        {retry === undefined ? null : (
          <button
            type="button"
            className="kt-btn min-h-[44px] self-start"
            data-variant="primary"
            data-machine-name-retry=""
            onClick={retry.onPress}
          >
            {retry.label}
          </button>
        )}
        {saved ? (
          <p role="status" className="m-0 text-meta font-semibold text-ok">
            Saved.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || reading}
          className="min-h-[44px] self-start rounded-control border border-border-strong bg-surface-3 px-control-x text-cell font-semibold text-fg hover:bg-surface-2 focus-visible:outline-focus focus-visible:outline-offset-focus disabled:opacity-60"
        >
          {busy ? 'Saving…' : reading ? 'Reading…' : 'Save'}
        </button>
      </form>
    </section>
  );
}

export function NameSettings({ client }: { readonly client: KernelClient }) {
  const [reading, setReading] = useState<Reading | undefined>(undefined);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const load = useCallback(
    async (initial: boolean, pressed = false) => {
      try {
        const next = await read(client, pressed);
        setReading(next);
        setRefused(undefined);
        setProblem(undefined);
        if (initial) setValue(next.source === 'owner' ? next.name : '');
      } catch (cause) {
        setProblem(reasonOf(cause));
        setRefused(retryLabel(cause));
      }
    },
    [client],
  );
  useEffect(() => {
    void load(true);
  }, [load]);

  const save = useCallback(async () => {
    if (reading === undefined) return;
    setSaved(false);
    const typed = value.trim();
    const parsed = typed === '' ? undefined : MachineNameSchema.safeParse(typed);
    if (parsed !== undefined && !parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'That name cannot be used.');
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      if (parsed === undefined) {
        // Empty: no name of the owner's at all, so the file goes (the host name returns).
        if (reading.source === 'owner')
          await client.call('DELETE /v1/config/file', { query: { path: HOST_FILE, etag: reading.etag } });
      } else {
        await writeConfigFile(client, HOST_FILE, hostFileText(parsed.data), reading.etag);
      }
      await load(false);
      if (parsed === undefined) setValue('');
      setSaved(true);
    } catch (cause) {
      setProblem(reasonOf(cause));
    } finally {
      setBusy(false);
    }
  }, [client, load, reading, value]);

  return (
    <NameSettingsView
      current={reading?.name ?? ''}
      source={reading?.source ?? 'hostname'}
      value={value}
      onChange={next => {
        setValue(next);
        setSaved(false);
      }}
      onSave={() => void save()}
      busy={busy}
      reading={reading === undefined}
      saved={saved}
      {...(reading === undefined && refused !== undefined
        ? { retry: { label: refused, onPress: () => void load(true, true) } }
        : {})}
      {...(problem === undefined ? {} : { problem })}
    />
  );
}
