import { beforeEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { must, mount, pressKey } from '../support/dom.ts';

beforeEach(() => writeMdComposePref('off'));

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceId: 'token-a',
});
const store = () => {
  const entries = new Map<string, string>();
  return new DaemonDraftStore({
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  });
};

describe('Composer Escape', () => {
  test('goes back when the owner supplied onEscape', async () => {
    let escaped = 0;
    const composer = await mount(
      <Composer
        api={{ send: async () => ({}) as never }}
        daemon={daemon}
        draftStore={store()}
        onEscape={() => {
          escaped += 1;
        }}
        sessionId="esc"
      />,
    );
    pressKey(must(composer.container.querySelector('textarea'), 'the textarea'), 'Escape');
    expect(escaped).toBe(1);
    await composer.unmount();
  });

  test('does nothing special without onEscape', async () => {
    const composer = await mount(
      <Composer api={{ send: async () => ({}) as never }} daemon={daemon} draftStore={store()} sessionId="esc2" />,
    );
    expect(() => pressKey(must(composer.container.querySelector('textarea'), 'the textarea'), 'Escape')).not.toThrow();
    await composer.unmount();
  });
});
