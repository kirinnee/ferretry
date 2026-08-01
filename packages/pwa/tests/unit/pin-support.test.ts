import { describe, expect, it } from 'bun:test';
import type { PinSnapshot } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  clearForegroundPinScope,
  getForegroundPinScope,
  registerPinJumpController,
  requestPinJump,
  setForegroundPinScope,
} from '../../src/lib/pin-bridge.ts';
import { DaemonPinClient } from '../../src/lib/pin-client.ts';
import { pinReferenceMarkdown } from '../../src/lib/pin-links.ts';
import { createPinReferenceResolver } from '../../src/lib/pin-reference-context.ts';
import { pinSelection, pinSelectionBlockId, truncatePinSelection } from '../../src/lib/pin-selection.ts';
import type { DaemonPinSnapshot } from '../../src/lib/pin-store.ts';
import '../support/dom.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'shared');
const scopeB = daemonSessionScope(daemonB, 'shared');

const board = (sessionId: string, text: string): PinSnapshot => ({
  v: 1,
  sessionId,
  updatedAt: '2026-08-01T00:00:00.000Z',
  pins: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      at: 1,
      kind: 'note',
      text,
      by: 'human',
      createdBy: null,
      createdByName: null,
    },
  ],
});

describe('pin support', () => {
  it('keeps foreground state and reference lookup scoped to the daemon as well as the session', () => {
    setForegroundPinScope(scopeA);
    expect(getForegroundPinScope()).toEqual(scopeA);
    clearForegroundPinScope(scopeB);
    expect(getForegroundPinScope()).toEqual(scopeA);

    const snapshot: DaemonPinSnapshot = {
      snapshots: new Map([
        [daemonSessionKey(scopeA), board('shared', 'Daemon A note')],
        [daemonSessionKey(scopeB), board('shared', 'Daemon B note')],
      ]),
      statuses: new Map(),
    };
    const resolve = createPinReferenceResolver(snapshot);
    const pinId = '11111111-1111-4111-8111-111111111111';
    expect(resolve({ ...scopeA, pinId })?.label).toBe('Daemon A note');
    expect(resolve({ ...scopeB, pinId })?.label).toBe('Daemon B note');
    expect(pinReferenceMarkdown({ ...scopeA, pinId, label: '  A\n pin  ' })).toBe('pin: A pin');
    clearForegroundPinScope(scopeA);
  });

  it('delegates only to the foreground transcript controller and exposes no-transcript honestly', async () => {
    expect(await requestPinJump('missing')).toBe('no-transcript');
    const calls: string[] = [];
    const removeBackground = registerPinJumpController({
      isForeground: () => false,
      jumpTo: async blockId => {
        calls.push(`background:${blockId}`);
        return 'jumped';
      },
    });
    const removeForeground = registerPinJumpController({
      isForeground: () => true,
      jumpTo: async (blockId, progress) => {
        progress?.(2);
        calls.push(`foreground:${blockId}`);
        return 'jumped';
      },
    });
    const progress: number[] = [];
    expect(await requestPinJump('block-1', value => progress.push(value))).toBe('jumped');
    expect(calls).toEqual(['foreground:block-1']);
    expect(progress).toEqual([2]);
    removeForeground();
    removeBackground();
  });

  it('truncates captured selections and adds them only to the connection that owns the foreground scope', async () => {
    const bodies: unknown[] = [];
    const client = new DaemonPinClient(undefined, async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(board('shared', 'authoritative')), { status: 200 });
    });
    setForegroundPinScope(scopeA);
    expect(truncatePinSelection('  useful selection  ')).toBe('useful selection');
    expect(truncatePinSelection('abcdef', 4)).toBe('abc…');
    expect(pinSelection(daemonB, client, 'useful selection', 'block-1')).toEqual({ ok: false, reason: 'no-session' });
    expect(pinSelection(daemonA, client, '  useful selection  ', 'block-1')).toEqual({ ok: true });
    await Promise.resolve();
    expect(bodies).toEqual([{ action: 'add', kind: 'note', text: 'useful selection', source: { blockId: 'block-1' } }]);
    expect(pinSelection(daemonA, client, '   ')).toEqual({ ok: false, reason: 'empty' });
    clearForegroundPinScope(scopeA);
  });

  it('finds an in-transcript selection endpoint without accepting an adjacent pane', () => {
    const root = document.createElement('main');
    const row = document.createElement('article');
    row.dataset.blockId = 'block-a';
    const child = document.createElement('em');
    const text = document.createTextNode('selected');
    child.append(text);
    row.append(child);
    root.append(row);
    const elsewhere = document.createElement('span');
    document.body.append(root, elsewhere);

    expect(pinSelectionBlockId(text, null, root)).toBe('block-a');
    expect(pinSelectionBlockId(null, row, root)).toBe('block-a');
    expect(pinSelectionBlockId(elsewhere, null, root)).toBeNull();
    expect(pinSelectionBlockId(null, null, root)).toBeNull();
    expect(pinSelectionBlockId(text, null, null)).toBeNull();
    root.remove();
    elsewhere.remove();
  });
});
