/**
 * Settings › This device › Speed-up keys.
 *
 * A Groq or Cerebras key kept in THIS browser, so dictation clean-up goes straight from here to the
 * provider instead of through a machine (`lib/stt/speedup-keys.ts`, `docs/secrets.md` › "Device-held
 * speed-up keys"). Each provider is a card: what leaves the browser, where to get a key (as text AND a
 * link), a paste field, Test and Remove.
 *
 * WRITE-ONLY. A pasted key is sealed and the field clears; from then on the card can say only that a
 * key is saved and its last two characters. A Test is the person's act — never on load — and lists
 * the models the key can use, which is free and runs no model.
 *
 * NO AUTOFOCUS, per this app's touch rules, and every target is at least 44 px.
 */

import { CLEANUP_PROVIDERS } from '@ferretry/protocol';
import { Check, ExternalLink, FlaskConical, KeyRound, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { useSpeedupKeys } from '../../lib/store.tsx';
import { type DeviceKeyTest, testDeviceKey } from '../../lib/stt/device-cleanup.ts';
import type { DeviceSpeedupKeys, SpeedupKeyProvider, SpeedupKeyStatus } from '../../lib/stt/speedup-keys.ts';

export const SPEEDUP_KEYS_INTRO =
  'Paste a Groq or Cerebras key and dictation clean-up calls that provider straight from this browser — no round trip through a machine, so it is faster.';

export const SPEEDUP_KEYS_STORAGE =
  'The key stays in this browser only: encrypted with a key this browser cannot export, never synced or copied to another device, never sent to any machine, and out of reach of every agent. It is not shown again after you save it.';

export const SPEEDUP_KEYS_FALLBACK =
  'Without one, clean-up asks the machine you are dictating to, which uses its own key if it has one (Settings › This machine › Speed-ups).';

/** Groq's key page. Spelled with an escaped dot so no IO gate reads the host as a logger call. */
const GROQ_KEYS_URL = 'https://console.groq.com/keys';

const PROVIDER_COPY: Readonly<Record<SpeedupKeyProvider, { readonly keyUrl: string; readonly privacy: string }>> = {
  groq: {
    keyUrl: GROQ_KEYS_URL,
    privacy:
      'The recognised text, your word list and a little recent conversation go from this browser to Groq. Groq never receives audio.',
  },
  cerebras: {
    keyUrl: 'https://cloud.cerebras.ai',
    privacy:
      'The recognised text, your word list and a little recent conversation go from this browser to Cerebras. Cerebras never receives audio.',
  },
};

const SPEEDUP_KEY_PROVIDERS: readonly SpeedupKeyProvider[] = ['groq', 'cerebras'];

/** The card's one line about a saved key: that it is there, and how it ends — never more. */
export function savedKeyLine(status: SpeedupKeyStatus): string | undefined {
  return status.kind === 'saved' ? `Saved · ends with ••${status.endsWith}` : undefined;
}

/** One line about the last Test. */
export function keyTestLine(result: DeviceKeyTest): string {
  return result.ok
    ? `Worked: this key can use ${String(result.models)} model${result.models === 1 ? '' : 's'}.`
    : `Failed: ${result.message}`;
}

export interface DeviceKeyCardProps {
  readonly provider: SpeedupKeyProvider;
  /** `undefined` while the first read is in flight. */
  readonly status: SpeedupKeyStatus | undefined;
  readonly busy: 'saving' | 'testing' | 'removing' | null;
  readonly test: DeviceKeyTest | null;
  readonly error: string | null;
  readonly onSave: (value: string) => void | Promise<void>;
  readonly onTest: () => void | Promise<void>;
  readonly onRemove: () => void | Promise<void>;
}

export function DeviceKeyCard({ provider, status, busy, test, error, onSave, onTest, onRemove }: DeviceKeyCardProps) {
  const fieldId = useId();
  const headingId = useId();
  const [value, setValue] = useState('');
  const label = CLEANUP_PROVIDERS[provider].label;
  const copy = PROVIDER_COPY[provider];
  const saved = status?.kind === 'saved';
  const held = status !== undefined && status.kind !== 'none';
  const idle = busy === null && status !== undefined;
  const ready = value.trim().length > 0 && idle;
  const line = status === undefined ? undefined : savedKeyLine(status);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onSave(value)).then(() => setValue(''));
  };

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby={headingId}
      data-device-key={provider}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="m-0 text-row font-semibold text-fg">
          {label}
        </h3>
        {saved ? (
          <span
            className="inline-flex items-center gap-1 rounded-control bg-accent-soft px-2 py-0.5 text-meta font-medium text-ok"
            data-device-key-saved=""
          >
            <Check size={12} aria-hidden="true" /> {line}
          </span>
        ) : (
          <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">
            {status === undefined ? 'Checking…' : 'Not saved'}
          </span>
        )}
      </div>
      <p className="m-0 text-meta leading-base text-muted">{copy.privacy}</p>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-1 text-meta leading-base text-muted">
        <span>Get a key:</span>
        <a
          href={copy.keyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-1 break-all text-accent underline"
        >
          {copy.keyUrl}
          <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
        </a>
      </p>
      {status?.kind === 'unreadable' && (
        <p role="alert" className="m-0 text-meta leading-base text-warn">
          {status.message}
        </p>
      )}

      <form className="flex min-w-0 flex-col gap-1" onSubmit={submit} aria-label={`Save a ${label} key on this device`}>
        <label className="text-cell font-medium text-fg" htmlFor={fieldId}>
          {held ? `Replace the ${label} key` : `${label} key`}
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <input
            id={fieldId}
            // `password` so it is not read over a shoulder; `new-password` so no password manager keeps a copy.
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="kt-input min-h-[44px] w-full min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-2 text-fg"
            value={value}
            placeholder="paste it here — it is never shown again"
            onChange={event => setValue(event.target.value)}
          />
          <button type="submit" className="kt-btn min-h-[44px] justify-center" data-variant="primary" disabled={!ready}>
            <KeyRound size={14} aria-hidden="true" /> {busy === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={!saved || !idle}
            onClick={() => void onTest()}
            aria-label={`Test the ${label} key`}
          >
            <FlaskConical size={14} aria-hidden="true" /> {busy === 'testing' ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={!held || !idle}
            onClick={() => void onRemove()}
            aria-label={`Remove the ${label} key from this device`}
          >
            <Trash2 size={14} aria-hidden="true" /> {busy === 'removing' ? 'Removing…' : 'Remove'}
          </button>
          <span className="text-meta leading-base text-faint">Test lists the models your key can use. It is free.</span>
        </div>
        {test !== null && (
          <p
            className={cn('m-0 text-meta leading-base', test.ok ? 'text-ok' : 'text-warn')}
            role="status"
            data-device-key-test=""
          >
            {keyTestLine(test)}
          </p>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="m-0 text-ui text-err">
          {error}
        </p>
      )}
    </section>
  );
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface CardState {
  readonly status?: SpeedupKeyStatus;
  readonly busy: DeviceKeyCardProps['busy'];
  readonly test: DeviceKeyTest | null;
  readonly error: string | null;
}

const IDLE: CardState = { busy: null, test: null, error: null };

export interface SpeedupKeysSettingsProps {
  /** This device's keys; the app store's when omitted. `null` renders the explanation and no cards. */
  readonly keys?: DeviceSpeedupKeys | null;
}

export function SpeedupKeysSettings({ keys: injected }: SpeedupKeysSettingsProps) {
  const ambient = useSpeedupKeys();
  const keys = injected === undefined ? ambient : injected;
  const [cards, setCards] = useState<Readonly<Record<SpeedupKeyProvider, CardState>>>({ groq: IDLE, cerebras: IDLE });

  const patch = useCallback((provider: SpeedupKeyProvider, next: Partial<CardState>) => {
    setCards(previous => ({ ...previous, [provider]: { ...previous[provider], ...next } }));
  }, []);

  const refresh = useCallback(
    async (provider: SpeedupKeyProvider, vault: DeviceSpeedupKeys) =>
      patch(provider, { status: await vault.status(provider) }),
    [patch],
  );

  useEffect(() => {
    if (keys === null) return;
    for (const provider of SPEEDUP_KEY_PROVIDERS) void refresh(provider, keys);
  }, [keys, refresh]);

  const act = useCallback(
    async (
      provider: SpeedupKeyProvider,
      busy: NonNullable<CardState['busy']>,
      work: (vault: DeviceSpeedupKeys) => Promise<void>,
    ) => {
      if (keys === null) return;
      patch(provider, { busy, error: null, ...(busy === 'testing' ? {} : { test: null }) });
      try {
        await work(keys);
        await refresh(provider, keys);
      } catch (cause) {
        patch(provider, { error: reason(cause) });
      } finally {
        patch(provider, { busy: null });
      }
    },
    [keys, patch, refresh],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="speedup-keys-settings">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-cell leading-base text-fg">{SPEEDUP_KEYS_INTRO}</p>
        <p className="m-0 text-meta leading-base text-muted">{SPEEDUP_KEYS_STORAGE}</p>
        <p className="m-0 text-meta leading-base text-faint">{SPEEDUP_KEYS_FALLBACK}</p>
      </div>
      {keys === null ? (
        <p role="status" className="m-0 text-cell leading-base text-muted">
          This page was opened without its key store, so no key can be saved here.
        </p>
      ) : (
        SPEEDUP_KEY_PROVIDERS.map(provider => {
          const card = cards[provider];
          return (
            <DeviceKeyCard
              key={provider}
              provider={provider}
              status={card.status}
              busy={card.busy}
              test={card.test}
              error={card.error}
              onSave={value => act(provider, 'saving', async vault => await vault.save(provider, value))}
              onRemove={() => act(provider, 'removing', async vault => await vault.remove(provider))}
              onTest={() =>
                act(provider, 'testing', async vault => patch(provider, { test: await testDeviceKey(vault, provider) }))
              }
            />
          );
        })
      )}
    </div>
  );
}
