import { describe, expect, it } from 'bun:test';
import type { ConversionPreview } from '@ferretry/protocol';
import { moveToOtherHarness, readConversionPreview } from '../../../../src/features/session-actions/conversion-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../../src/lib/runtime-models.ts';
import { sessionView } from '../../../support/sessions.ts';

const daemon = daemonConnection({ daemonId: 'd-a', baseUrl: 'https://a.invalid', deviceId: 'tok' });
const other = daemonConnection({ daemonId: 'd-b', baseUrl: 'https://b.invalid', deviceId: 'tok' });
const scope = daemonSessionScope(daemon, 's/1');

const ready: ConversionPreview = {
  kind: 'ready',
  targetAgent: 'codex-a',
  targetModel: 'gpt-5.5',
  summary: {
    converter: 1,
    sourceHarness: 'claude',
    targetHarness: 'codex',
    targetVersion: '0.163.0',
    turns: 3,
    keptTurns: 3,
    omittedTurns: 0,
    cutNewest: false,
    messages: 6,
    nativeToolCalls: 0,
    toolCallsAsText: 0,
    attachments: 0,
    dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
    estimatedTokens: 10,
    budgetTokens: 100,
  },
};

describe('readConversionPreview', () => {
  it('POSTs the agent to the session’s preview route and parses the answer', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const answer = await readConversionPreview(
      daemon,
      scope,
      async (input, init) => {
        seen.push({ url: String(input), init });
        return Response.json(ready);
      },
      'codex-a',
    );
    expect(answer).toEqual(ready);
    expect(seen[0]?.url).toBe('https://a.invalid/v1/sessions/s%2F1/conversion-preview');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ agent: 'codex-a' }));
  });

  it('passes an abort signal through', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    await readConversionPreview(
      daemon,
      scope,
      async (_input, init) => {
        signal = init?.signal;
        return Response.json({ kind: 'refused', targetAgent: 'codex-a', reason: 'no' });
      },
      'codex-a',
      controller.signal,
    );
    expect(signal).toBe(controller.signal);
  });

  it('refuses a scope another daemon owns', async () => {
    await expect(readConversionPreview(other, scope, async () => Response.json(ready), 'x')).rejects.toThrow(
      'does not own this session scope',
    );
  });

  it('turns an error body into a DaemonResponseError with its sentence and code', async () => {
    const failing = readConversionPreview(
      daemon,
      scope,
      async () => Response.json({ error: 'no such agent', code: 'unknown_agent' }, { status: 404 }),
      'x',
    );
    await expect(failing).rejects.toMatchObject({ status: 404, message: 'no such agent', code: 'unknown_agent' });
    const bare = readConversionPreview(daemon, scope, async () => new Response('x', { status: 500 }), 'x');
    await expect(bare).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
    await expect(bare).rejects.toBeInstanceOf(DaemonResponseError);
  });

  it('fails a body it cannot read', async () => {
    await expect(
      readConversionPreview(daemon, scope, async () => Response.json({ kind: 'maybe' }), 'x'),
    ).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe('moveToOtherHarness', () => {
  it('migrates with conversation convert and the request id, forcing only when told to', async () => {
    const calls: unknown[][] = [];
    const client = {
      migrate: async (...args: unknown[]) => {
        calls.push(args);
        return sessionView('s1');
      },
    };
    const view = sessionView('s1');
    await moveToOtherHarness(client, view, 'codex-a', 'req-1', false);
    await moveToOtherHarness(client, view, 'codex-a', 'req-2', true);
    expect(calls).toEqual([
      ['s1', 'codex-a', undefined, false, 'req-1', undefined, 'convert'],
      ['s1', 'codex-a', undefined, false, 'req-2', true, 'convert'],
    ]);
  });
});
