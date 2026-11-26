/**
 * The Map style choice on screen: the hook the map reads and the Settings › Appearance row that changes it.
 * `fy-render-map-style.ts` decides; this file only holds the choice live and draws the row.
 *
 * The key is typed into the shared secret field (an uncontrolled input, so the characters are never in React state or
 * the input's `value` attribute) and goes to this browser's storage and nowhere else: not the daemon, not a URL, not a
 * log. A stored key reads as a mask, never the value.
 */

import { Segmented, SettingRow } from '@ferretry/app';
import { Button, SecretInput, useSecretField } from '@ferretry/app/ui';
import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import {
  GOOGLE_KEY_NOTE,
  GOOGLE_MAPS_PRIVACY_NOTE,
  loadMapChoice,
  type MapChoice,
  type MapChoiceStorage,
  type MapStyle,
  readEmbedKey,
  saveMapChoice,
} from './fy-render-map-style.ts';

/** What a stored key shows instead of its value: a constant, so not even the length is given away. */
const MASK = '••••••••••••';

const OPTIONS: readonly { readonly id: MapStyle; readonly label: string }[] = [
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'google', label: 'Google Maps' },
];

const listeners = new Set<() => void>();
let held: { readonly choice: MapChoice } | null = null;

const current = (): MapChoice => {
  held ??= { choice: loadMapChoice() };
  return held.choice;
};

/** Keeps a new choice, tells every open map, and answers whether this browser kept it. */
const change = (next: MapChoice, storage?: MapChoiceStorage | null): boolean => {
  const kept = saveMapChoice(next, storage);
  held = { choice: next };
  for (const listener of listeners) listener();
  return kept;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (): void => {
    held = null;
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
};

/** The reader's map choice, live in every map and in the Settings row. */
export const useMapChoice = (): MapChoice => useSyncExternalStore(subscribe, current, current);

/** Forgets what was read (a test starts from empty storage). */
export const resetMapChoiceForTest = (): void => {
  held = null;
};

export function MapStyleRow() {
  const choice = useMapChoice();
  const field = useSecretField();
  const keyId = useId();
  const [typed, setTyped] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const showBox = choice.key === null || replacing;

  const pick = useCallback((style: MapStyle) => {
    setProblem(
      change({ key: current().key, style })
        ? null
        : 'This browser would not keep the choice; it holds for this page only.',
    );
  }, []);
  const save = (): void => {
    const key = readEmbedKey(field.read());
    if (key === null) {
      setProblem('That is not a Google Maps key. It is one word of letters, digits, - and _.');
      return;
    }
    field.clear();
    setTyped(0);
    setReplacing(false);
    setProblem(
      change({ key, style: current().style })
        ? null
        : 'This browser would not keep the key; it holds for this page only.',
    );
  };
  const remove = (): void => {
    change({ key: null, style: current().style });
    setProblem(null);
    setReplacing(false);
  };

  return (
    <SettingRow
      name="Map style"
      hint={
        choice.style === 'google' && choice.key === null
          ? 'Google Maps needs its key on this device'
          : GOOGLE_MAPS_PRIVACY_NOTE
      }
      explanation={`OpenStreetMap is the default. Google Maps draws one marker or a plain view; anything more stays on OpenStreetMap. Choosing it tells Google which places you open. ${GOOGLE_KEY_NOTE} You enter it once on each device.`}
      wide
      control={() => (
        <div className="flex w-full min-w-0 flex-col gap-3 md:w-96" data-map-style-row="">
          <Segmented label="Map style" value={choice.style} options={OPTIONS} onChange={pick} fill />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={keyId} className="text-ui font-semibold text-fg">
              Google Maps Embed API key
            </label>
            {showBox ? (
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <SecretInput
                  id={keyId}
                  field={field}
                  className="kt-input min-w-0 flex-1"
                  placeholder="Paste your key"
                  data-map-style-key="input"
                  onTyped={setTyped}
                />
                <Button type="button" data-map-style-key="save" disabled={typed === 0} onClick={save}>
                  Save key
                </Button>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <input
                  id={keyId}
                  readOnly
                  tabIndex={-1}
                  className="kt-input min-w-0 flex-1 text-muted"
                  value={MASK}
                  aria-label="Google Maps Embed API key: stored on this device"
                  data-map-style-key="stored"
                />
                <div className="flex gap-2">
                  <Button type="button" data-map-style-key="replace" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                  <Button type="button" data-map-style-key="remove" onClick={remove}>
                    Remove
                  </Button>
                </div>
              </div>
            )}
            <p className="m-0 text-ui text-muted" data-map-style-key="note">
              {choice.key === null
                ? 'No key on this device, so maps stay on OpenStreetMap. '
                : 'A key is stored on this device. '}
              {GOOGLE_KEY_NOTE}
            </p>
            {problem === null ? null : (
              <p className="m-0 text-ui text-err" role="alert" data-map-style-key="problem">
                {problem}
              </p>
            )}
          </div>
        </div>
      )}
    />
  );
}

export { change as changeMapChoice };
