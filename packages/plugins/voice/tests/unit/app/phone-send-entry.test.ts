import { describe, expect, test } from 'bun:test';
import { enterVoice } from '../../../app/lib/voice-mode/phone-send.ts';

describe('a phone on its own speech asks the machine to tell the ferret', () => {
  test('it asks once, by route, with the ferret and the session, and says nothing back', async () => {
    const calls: { route: string; body: unknown }[] = [];
    await enterVoice(
      {
        call: async (route: string, init?: { body?: unknown }) => {
          calls.push({ route, body: init?.body });
          return { sent: true } as never;
        },
      },
      'ferret-1',
      'vm-test-session',
    );
    expect(calls).toEqual([
      { route: 'POST /v1/voice/entry', body: { ferretId: 'ferret-1', session: 'vm-test-session' } },
    ]);
  });

  test('a machine that does not answer is not an error the person sees: the phone carries on', async () => {
    await expect(
      enterVoice(
        {
          call: async () => {
            throw new Error('offline');
          },
        },
        'ferret-1',
        'vm-test-session',
      ),
    ).resolves.toBeUndefined();
  });
});
