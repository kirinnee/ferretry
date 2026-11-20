/**
 * The key row (r11 O7): ONE provider's write-only key field, Save and Test, connected, so a page that is not Settings
 * (the Warden's first run) can mount the Jev one through Voice's `speedup-key` panel.
 */
import { describe, expect, it } from 'bun:test';
import { panelsInSlot } from '@ferretry/app/testing';
import type { Instant } from '@ferretry/std';
import { SpeedupKeyRow } from '../../../../app/features/speedups/key-row.tsx';
import { daemonConnection } from '../../../../app/shell-voice.ts';
import { mount, must, submit, typeInto } from '../../../support/app/dom.ts';
import type { SpeedupsView } from '../../../../contract/index.ts';

const AT = '2026-10-16T10:00:00.000Z' as Instant;
const KEY = 'jev-test-0123456789abcdef';
const connection = daemonConnection({ daemonId: 'a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });

const status = (provider: 'jev' | 'groq', set: boolean) => ({
  provider,
  label: provider === 'jev' ? 'Jev' : 'Groq',
  purpose: 'Does a thing.',
  costNote: 'Cheap.',
  privacyNote: 'A summary.',
  keyUrl: `https://keys.example.test/${provider}`,
  testNote: 'One decision.',
  secretName: provider === 'jev' ? 'JEV_API_KEY' : 'GROQ_API_KEY',
  set,
  testStale: false,
});

function fake(calls: string[], bodies: string[]) {
  let jevSet = false;
  return async () =>
    ({
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/secrets') {
          bodies.push(String(init?.body));
          jevSet = true;
          return schema.parse({ name: 'JEV_API_KEY', createdAt: AT, updatedAt: AT });
        }
        if (path.endsWith('/test'))
          return schema.parse({
            provider: 'jev',
            secretName: 'JEV_API_KEY',
            ok: true,
            code: 'ok',
            message: 'The key works.',
            at: AT,
          });
        const view: SpeedupsView = { vault: 'ok', providers: [status('jev', jevSet), status('groq', true)] };
        return schema.parse(view);
      },
    }) as never;
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('SpeedupKeyRow', () => {
  it('draws only the named provider, in the short form: no purpose line, "Get a key" and no URL text', async () => {
    const mounted = await mount(<SpeedupKeyRow connection={connection} provider="jev" createClient={fake([], [])} />);
    try {
      await settle();
      const row = must(mounted.container.querySelector('[data-speedup-key-row="jev"]'), 'the Jev row');
      expect(row.textContent).toContain('Jev key');
      expect(row.textContent).toContain('Get a key');
      expect(row.textContent).not.toContain('Does a thing.');
      expect(row.textContent).not.toContain('keys.example.test');
      expect(row.textContent).not.toContain('Groq');
      expect(mounted.container.querySelectorAll('input[type=password]').length).toBe(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('saves the pasted key once through the secret route, clears it, and never shows it again', async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const mounted = await mount(
      <SpeedupKeyRow connection={connection} provider="jev" createClient={fake(calls, bodies)} />,
    );
    try {
      await settle();
      const input = must(mounted.container.querySelector('input'), 'the key field');
      await typeInto(input, KEY);
      expect(mounted.container.innerHTML).not.toContain(KEY);
      await submit(mounted.container.querySelector('form'));
      await settle();
      expect(calls.filter(call => call === 'POST /v1/secrets').length).toBe(1);
      expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ name: 'JEV_API_KEY', value: KEY });
      // Set now: the field is gone, the markup and every field are clean.
      expect(mounted.container.innerHTML).not.toContain(KEY);
      expect(mounted.container.querySelector('input')).toBeNull();
      expect(mounted.container.querySelector('[data-speedup-set]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('says a failed read is not "none set"', async () => {
    const mounted = await mount(
      <SpeedupKeyRow
        connection={connection}
        provider="jev"
        createClient={async () => {
          throw new Error('the daemon is unreachable');
        }}
      />,
    );
    try {
      await settle();
      expect(mounted.container.textContent).toContain('the daemon is unreachable');
      expect(mounted.container.textContent).toContain('not the same as none');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the speedup-key panel', () => {
  it('is placed in the settings slot under Voice', () => {
    expect(panelsInSlot('settings')).toContain('voice.speedup-key');
  });
});
