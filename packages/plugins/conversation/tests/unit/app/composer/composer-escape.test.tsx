import { beforeEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore } from '../../../../app/composer/drafts.ts';
import { writeMdComposePref } from '@ferretry/app';
import { must, mount, pressKey } from '@ferretry/app/testing';

beforeEach(() => writeMdComposePref('off'));

const daemon = daemonConnection('daemon-a');
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
        ferretId="esc"
      />,
    );
    pressKey(must(composer.container.querySelector('textarea'), 'the textarea'), 'Escape');
    expect(escaped).toBe(1);
    await composer.unmount();
  });

  test('does nothing special without onEscape', async () => {
    const composer = await mount(
      <Composer api={{ send: async () => ({}) as never }} daemon={daemon} draftStore={store()} ferretId="esc2" />,
    );
    expect(() => pressKey(must(composer.container.querySelector('textarea'), 'the textarea'), 'Escape')).not.toThrow();
    await composer.unmount();
  });
});
