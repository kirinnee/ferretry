/**
 * Settings › This device › Speed-up keys, driven against a real vault (real WebCrypto, in-memory
 * records) whose network is a fake provider. What matters is what the screen never does: show a key
 * after it is saved, or test one on load.
 */

import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  DeviceKeyCard,
  keyTestLine,
  SPEEDUP_KEYS_FALLBACK,
  SPEEDUP_KEYS_INTRO,
  SPEEDUP_KEYS_STORAGE,
  SpeedupKeysSettings,
  savedKeyLine,
} from '../../../../src/features/settings/speedup-keys-settings.tsx';
import { DeviceSpeedupKeys, SPEEDUP_KEY_SHAPE_SENTENCE } from '../../../../src/lib/stt/speedup-keys.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const KEY = 'gsk_test_0123456789abcdXY';
const noop = () => undefined;

const vault = (answer: () => Response = () => Response.json({ data: [{ id: 'a' }, { id: 'b' }] })) => {
  const records = new Map<string, unknown>();
  const urls: string[] = [];
  const keys = new DeviceSpeedupKeys(
    {
      get: async slot => records.get(slot),
      put: async (slot, value) => void records.set(slot, value),
      delete: async slot => void records.delete(slot),
    },
    crypto.subtle,
    async url => {
      urls.push(String(url));
      return answer();
    },
  );
  return { keys, records, urls };
};

/** Lets WebCrypto and the vault's promises settle, inside `act`. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 6; round += 1) {
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 3)));
  }
};

const card = (renderer: ReactTestRenderer, provider: string): ReactTestInstance =>
  renderer.root.find(node => node.type === 'section' && node.props['data-device-key'] === provider);
const button = (scope: ReactTestInstance, label: string): ReactTestInstance =>
  scope.find(node => node.type === 'button' && node.props['aria-label'] === label);
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join(' ');
const text = (node: ReactTestInstance | ReactTestRenderer): string => textOf('root' in node ? node.root : node);

describe('the speed-up keys lines', () => {
  it('should say only that a key is saved and how it ends', () => {
    expect(savedKeyLine({ kind: 'saved', endsWith: 'XY' })).toBe('Saved · ends with ••XY');
    expect(savedKeyLine({ kind: 'none' })).toBeUndefined();
    expect(keyTestLine({ ok: true, models: 1 })).toBe('Worked: this key can use 1 model.');
    expect(keyTestLine({ ok: true, models: 3 })).toBe('Worked: this key can use 3 models.');
    expect(keyTestLine({ ok: false, message: 'Groq rejected it.' })).toBe('Failed: Groq rejected it.');
  });
});

describe('Settings › This device › Speed-up keys', () => {
  it('should say what it is, where the key lives, and what happens without one, and test nothing on load', async () => {
    // Arrange
    const { keys, urls } = vault();

    // Act
    const renderer = render(<SpeedupKeysSettings keys={keys} />);
    await settle();

    // Assert
    const page = text(renderer);
    for (const sentence of [SPEEDUP_KEYS_INTRO, SPEEDUP_KEYS_STORAGE, SPEEDUP_KEYS_FALLBACK])
      expect(page).toContain(sentence);
    expect(page).toContain('Not saved');
    expect(page).toContain('https://console.groq.com/keys');
    expect(page).toContain('https://cloud.cerebras.ai');
    expect(button(card(renderer, 'groq'), 'Test the Groq key').props.disabled).toBe(true);
    expect(button(card(renderer, 'groq'), 'Remove the Groq key from this device').props.disabled).toBe(true);
    expect(urls).toEqual([]);
  });

  it('should save a key, clear the field, and never show the key again', async () => {
    // Arrange
    const { keys } = vault();
    const renderer = render(<SpeedupKeysSettings keys={keys} />);
    await settle();
    const groq = card(renderer, 'groq');

    // Act
    run(() => groq.findByType('input').props.onChange({ target: { value: `  ${KEY}  ` } }));
    await runAsync(async () => groq.findByType('form').props.onSubmit({ preventDefault: noop }));
    await settle();

    // Assert
    const page = text(renderer);
    expect(page).toContain('Saved · ends with ••XY');
    expect(page).not.toContain(KEY);
    expect(card(renderer, 'groq').findByType('input').props.value).toBe('');
    expect(text(card(renderer, 'groq'))).toContain('Replace the Groq key');
    expect(text(card(renderer, 'cerebras'))).toContain('Not saved');
  });

  it('should Test a saved key against its own provider, then Remove it', async () => {
    // Arrange
    const { keys, urls } = vault();
    await keys.save('groq', KEY);
    const renderer = render(<SpeedupKeysSettings keys={keys} />);
    await settle();

    // Act
    await runAsync(async () => button(card(renderer, 'groq'), 'Test the Groq key').props.onClick());
    await settle();
    const tested = text(card(renderer, 'groq'));
    await runAsync(async () => button(card(renderer, 'groq'), 'Remove the Groq key from this device').props.onClick());
    await settle();

    // Assert
    expect(urls).toEqual(['https://api.groq.com/openai/v1/models']);
    expect(tested).toContain('Worked: this key can use 2 models.');
    expect(text(card(renderer, 'groq'))).toContain('Not saved');
    expect(await keys.status('groq')).toEqual({ kind: 'none' });
  });

  it('should say why a pasted value was refused, and keep nothing', async () => {
    // Arrange
    const { keys, records } = vault();
    const renderer = render(<SpeedupKeysSettings keys={keys} />);
    await settle();
    const cerebras = card(renderer, 'cerebras');

    // Act
    run(() => cerebras.findByType('input').props.onChange({ target: { value: 'not a key' } }));
    await runAsync(async () => cerebras.findByType('form').props.onSubmit({ preventDefault: noop }));
    await settle();

    // Assert
    expect(text(card(renderer, 'cerebras'))).toContain(SPEEDUP_KEY_SHAPE_SENTENCE);
    expect(records.size).toBe(0);
  });

  it('should say a key this browser can no longer open is unreadable, and still allow Remove', async () => {
    // Arrange
    const { keys, records } = vault();
    records.set('provider:groq', 'damaged');

    // Act
    const renderer = render(<SpeedupKeysSettings keys={keys} />);
    await settle();

    // Assert
    expect(text(card(renderer, 'groq'))).toContain('can no longer open the key it saved');
    expect(button(card(renderer, 'groq'), 'Remove the Groq key from this device').props.disabled).toBe(false);
    expect(button(card(renderer, 'groq'), 'Test the Groq key').props.disabled).toBe(true);
  });

  it('should say so when the page has no key store', () => {
    // Act
    const renderer = render(<SpeedupKeysSettings keys={null} />);

    // Assert
    expect(text(renderer)).toContain('no key can be saved here');
    expect(renderer.root.findAll(node => node.type === 'section')).toHaveLength(0);
  });

  it('should read the app store’s keys when none are handed in', () => {
    // Act — outside a store there are none, which is the honest answer.
    const renderer = render(<SpeedupKeysSettings />);

    // Assert
    expect(text(renderer)).toContain('no key can be saved here');
  });
});

describe('one key card', () => {
  const base = {
    provider: 'groq' as const,
    test: null,
    error: null,
    onSave: noop,
    onTest: noop,
    onRemove: noop,
  };

  it('should show each busy state and lock every action while one runs', () => {
    for (const [busy, label] of [
      ['saving', 'Saving…'],
      ['testing', 'Testing…'],
      ['removing', 'Removing…'],
    ] as const) {
      const renderer = render(<DeviceKeyCard {...base} status={{ kind: 'saved', endsWith: 'XY' }} busy={busy} />);
      expect(text(renderer)).toContain(label);
      expect(button(renderer.root, 'Test the Groq key').props.disabled).toBe(true);
    }
  });

  it('should not submit an empty field, and say it is checking before the first read', () => {
    // Arrange
    const saved: string[] = [];
    const renderer = render(
      <DeviceKeyCard {...base} status={undefined} busy={null} onSave={value => void saved.push(value)} />,
    );

    // Act
    run(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: noop }));

    // Assert
    expect(saved).toEqual([]);
    expect(text(renderer)).toContain('Checking…');
  });

  it('should show a failed Test and an error', () => {
    // Act
    const renderer = render(
      <DeviceKeyCard
        {...base}
        status={{ kind: 'saved', endsWith: 'XY' }}
        busy={null}
        test={{ ok: false, message: 'Groq rejected it.' }}
        error="Something went wrong."
      />,
    );

    // Assert
    expect(text(renderer)).toContain('Failed: Groq rejected it.');
    expect(text(renderer)).toContain('Something went wrong.');
  });
});
