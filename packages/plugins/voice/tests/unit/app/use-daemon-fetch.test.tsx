/**
 * `fetch-binding` (finding 8): a daemon request goes through the plugin client. Outside a client and a store carrier
 * `useDaemonFetch` refuses — it never falls back to the plain network, so `browserFetch` stays model downloads and
 * speed-up provider calls only.
 */

import { describe, expect, it } from 'bun:test';
import type { DaemonFetch } from '../../../app/shell-voice.ts';
import { useDaemonFetch } from '../../../app/lib/voice-store.tsx';
import { mount } from '../../support/app/dom.ts';

describe('useDaemonFetch outside a daemon client', () => {
  it('refuses and sends nothing, never the plain network', async () => {
    let seen: DaemonFetch | undefined;
    function Probe() {
      seen = useDaemonFetch();
      return null;
    }
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      sent.push(args);
      return new Response('{}');
    }) as typeof fetch;
    try {
      const view = await mount(<Probe />);
      expect(seen).toBeDefined();
      await expect((seen as DaemonFetch)('/v1/stt/enhance', { method: 'POST', body: '{}' })).rejects.toThrow(
        'no daemon client is open here, so the request was not sent',
      );
      expect(sent).toEqual([]);
      await view.unmount();
    } finally {
      globalThis.fetch = real;
    }
  });
});
