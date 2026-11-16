import { describe, expect, test } from 'bun:test';
import { aboveComposerProps } from '../../../../app/chat/above-composer-props.ts';
import { chatReadApi } from '../../../../app/chat/chat-reads.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { ferretSummary } from '../../../support/app/ferret-view.ts';

/**
 * WHAT THE ABOVE-COMPOSER SLOT IS HANDED, from what the daemon's two routes answer: Ferrets' summary and the observer's
 * redacted prompt read, through the chat's own read (`chatReadApi.get`), `chatSessionOf` and `aboveComposerProps`.
 * Voice's suite (`auto-read-boundary.test.tsx`) feeds its panel exactly these literals; a package reaches another only
 * through its contract, so the two suites meet at `ConversationAboveComposerProps`.
 */

const SUMMARY = 'GET /v1/ferrets/:ferretId';
const PROMPT = 'GET /v1/ferrets/:ferretId/prompt';
const iso = (n: number): string => new Date(Date.UTC(2026, 10, 5) + n).toISOString();

const REQUEST = {
  id: '0123456789abcdef',
  harness: 'claude',
  tool: 'Bash',
  action: 'run',
  question: 'Run first?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

/** The slot's props for one ferret read: the registry's summary, and the prompt route's answer (a failure when `prompt` is `'fails'`). */
const slotFor = async (
  registry: { readonly state: 'working' | 'idle'; readonly stateAt: number },
  prompt: Record<string, unknown> | 'fails',
) => {
  const client = fakeClient({
    [SUMMARY]: () => ferretSummary('f', { state: registry.state, stateAt: iso(registry.stateAt) }),
    [PROMPT]: () => {
      if (prompt === 'fails') throw new Error('the daemon refused');
      return prompt;
    },
  });
  const session = await chatReadApi(client).get('f');
  return aboveComposerProps({ session, entries: [], sends: [], question: null, ended: false, live: true });
};

describe('the slot’s turn facts are the observer’s, not the registry’s', () => {
  test('a turn that finished is your-turn at the observer’s instant, whatever the registry stamped later', async () => {
    const props = await slotFor(
      { state: 'idle', stateAt: 10_001 },
      { turnState: 'your-turn', turnStateAt: iso(10_000) },
    );
    expect(props.turn).toEqual({ state: 'your-turn', at: iso(10_000), live: true });
  });

  test('a delayed registry stamp does not move the turn’s instant', async () => {
    const props = await slotFor(
      { state: 'working', stateAt: 20_000 },
      { turnState: 'working', turnStateAt: iso(1000) },
    );
    expect(props.turn).toEqual({ state: 'working', at: iso(1000), live: true });
  });

  test('a permission prompt is needs-input (not your-turn) with the request as data', async () => {
    const props = await slotFor(
      { state: 'idle', stateAt: 10_500 },
      { turnState: 'needs-input', turnStateAt: iso(10_000), permissionRequest: REQUEST },
    );
    expect(props.turn).toEqual({ state: 'needs-input', at: iso(10_000), live: true });
    expect(props.needsInput).toEqual({
      permissionRequest: { tool: 'Bash', question: 'Run first?', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
  });

  test('a prompt read that failed claims no instant: the slot has nothing to date a turn by', async () => {
    const props = await slotFor({ state: 'idle', stateAt: 10_000 }, 'fails');
    expect(props.turn.at).toBeUndefined();
    expect(props.turn.state).toBe('your-turn');
  });
});
