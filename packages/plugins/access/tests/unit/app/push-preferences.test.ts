import { describe, expect, it } from 'bun:test';
import { daemonId } from '../../../app/shell-pairing.ts';
import { NOTIFICATION_PREFERENCES_KEY, PushPreferences } from '../../../app/lib/push-preferences.ts';

const memory = (seed?: string) => {
  const values = new Map<string, string>(seed === undefined ? [] : [[NOTIFICATION_PREFERENCES_KEY, seed]]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe('PushPreferences', () => {
  it('is off for a machine until the reader turns it on, and remembers the switch in storage', () => {
    const storage = memory();
    const preferences = new PushPreferences(storage);
    const a = daemonId('daemon-a');
    expect(preferences.get(a).enabled).toBe(false);
    preferences.set(a, { enabled: true });
    expect(new PushPreferences(storage).get(a).enabled).toBe(true);
  });

  it('writes the switch back beside Agenda’s onlyWhenHidden without resetting it', () => {
    const storage = memory(
      JSON.stringify({ version: 1, daemons: { 'daemon-a': { enabled: false, onlyWhenHidden: false } } }),
    );
    new PushPreferences(storage).set(daemonId('daemon-a'), { enabled: true });
    expect(JSON.parse(storage.values.get(NOTIFICATION_PREFERENCES_KEY) ?? '{}')).toEqual({
      version: 1,
      daemons: { 'daemon-a': { enabled: true, onlyWhenHidden: false } },
    });
  });

  it('keeps working in memory when storage refuses, and ignores a store it cannot read', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const preferences = new PushPreferences(refusing);
    preferences.set(daemonId('daemon-a'), { enabled: true });
    expect(preferences.get(daemonId('daemon-a')).enabled).toBe(true);
    expect(new PushPreferences(memory('{not json')).get(daemonId('daemon-a')).enabled).toBe(false);
  });
});
