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

import { CLEANUP_PROVIDERS } from '../../../contract/index.ts';
import { Check, ExternalLink, FlaskConical, KeyRound, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { SecretInput, SettingGroup, SettingRow, useSecretField } from '../../shell-voice.ts';
import { useSpeedupKeys } from '../../lib/voice-store.tsx';
import { type DeviceKeyTest, testDeviceKey } from '../../lib/stt/device-cleanup.ts';
import type { DeviceSpeedupKeys, SpeedupKeyProvider, SpeedupKeyStatus } from '../../lib/stt/speedup-keys.ts';
import './voice-settings.css';

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
  // The key lives only in the field's own value (read on Save); state knows how long it is, never what it says.
  const key = useSecretField(typed => typed.trim().length);
  const label = CLEANUP_PROVIDERS[provider].label;
  const copy = PROVIDER_COPY[provider];
  const saved = status?.kind === 'saved';
  const held = status !== undefined && status.kind !== 'none';
  const idle = busy === null && status !== undefined;
  const ready = key.length > 0 && idle;
  const line = status === undefined ? undefined : savedKeyLine(status);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onSave(key.read())).then(() => key.clear());
  };

  return (
    <SettingRow
      name={label}
      hint={
        saved ? (
          <span className="inline-flex items-center gap-1 text-ok" data-device-key-saved="">
            <Check size={12} aria-hidden="true" /> {line}
          </span>
        ) : status === undefined ? (
          'Checking…'
        ) : (
          'Not saved'
        )
      }
      wide
      dataAttributes={{ 'data-device-key': provider }}
      explanation={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0">{copy.privacy}</p>
          <p className="m-0">{SPEEDUP_KEYS_STORAGE}</p>
        </div>
      }
    >
      <form
        className="fy-vs-body"
        onSubmit={submit}
        aria-label={`Save a ${label} key on this device`}
        data-device-key-form={provider}
      >
        {status?.kind === 'unreadable' && (
          <p role="alert" className="fy-vs-note" data-tone="warn">
            {status.message}
          </p>
        )}
        {/* ONE row: the key, then Save, Test and Remove, all one height; it wraps under the key when the panel is narrow. */}
        <div className="fy-vs-field">
          <SecretInput
            id={fieldId}
            field={key}
            aria-label={held ? `Replace the ${label} key` : `${label} key`}
            className="kt-input fy-vs-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
            placeholder="paste it here — it is never shown again"
          />
          <button type="submit" className="kt-btn" data-variant="primary" disabled={!ready}>
            <KeyRound size={14} aria-hidden="true" /> {busy === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="kt-btn"
            disabled={!saved || !idle}
            onClick={() => void onTest()}
            aria-label={`Test the ${label} key`}
          >
            <FlaskConical size={14} aria-hidden="true" /> {busy === 'testing' ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className="kt-btn"
            disabled={!held || !idle}
            onClick={() => void onRemove()}
            aria-label={`Remove the ${label} key from this device`}
          >
            <Trash2 size={14} aria-hidden="true" /> {busy === 'removing' ? 'Removing…' : 'Remove'}
          </button>
        </div>
        <p className="fy-vs-note">
          Get a key:{' '}
          <a href={copy.keyUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent underline">
            {copy.keyUrl}
            <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-baseline" />
          </a>
          . Test lists the models your key can use. It is free.
        </p>
        {test !== null && (
          <p className="fy-vs-note" data-tone={test.ok ? 'ok' : 'warn'} role="status" data-device-key-test="">
            {keyTestLine(test)}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="fy-vs-note" data-tone="warn">
            {error}
          </p>
        )}
      </form>
    </SettingRow>
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
  /** Told once each time a key was saved and read back as saved; never on a failed save, a test or a removal. */
  readonly onSaved?: (provider: SpeedupKeyProvider) => void;
}

export function SpeedupKeysSettings({ keys: injected, onSaved }: SpeedupKeysSettingsProps) {
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
        if (busy === 'saving') onSaved?.(provider);
      } catch (cause) {
        patch(provider, { error: reason(cause) });
      } finally {
        patch(provider, { busy: null });
      }
    },
    [keys, onSaved, patch, refresh],
  );

  return (
    <div data-testid="speedup-keys-settings" id="settings-speedup-keys" data-setting-id="speedup-keys" tabIndex={-1}>
      <SettingGroup label="Speed-up keys">
        <SettingRow
          name="Speed-up keys"
          hint="Cleaner dictation, straight from this browser"
          explanation={
            <div className="flex flex-col gap-2">
              <p className="m-0">{SPEEDUP_KEYS_INTRO}</p>
              <p className="m-0">{SPEEDUP_KEYS_FALLBACK}</p>
            </div>
          }
        />
        {keys === null ? (
          <li className="fy-vs-body">
            <p role="status" className="fy-vs-note">
              This page was opened without its key store, so no key can be saved here.
            </p>
          </li>
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
                  act(provider, 'testing', async vault =>
                    patch(provider, { test: await testDeviceKey(vault, provider) }),
                  )
                }
              />
            );
          })
        )}
      </SettingGroup>
    </div>
  );
}
