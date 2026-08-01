import { describe, expect, it } from 'bun:test';
import {
  useAttentionCount,
  useAttentionItems,
  useAttentionResolutions,
  useAttentionSession,
  useAttentionSnapshot,
} from '../../src/hooks/use-attention.ts';
import {
  useDeclareForegroundPinScope,
  useForegroundPinScope,
  useMessagePinned,
  usePinCount,
  usePinsSession,
  useSessionPins,
} from '../../src/hooks/use-pins.ts';
import { DaemonAttentionClient } from '../../src/lib/attention-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { getForegroundPinScope } from '../../src/lib/pin-bridge.ts';
import { DaemonPinClient } from '../../src/lib/pin-client.ts';
import { render, run } from '../support/react.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const scope = daemonSessionScope(daemon, 'session-a');

const pins = {
  v: 1 as const,
  sessionId: 'session-a',
  updatedAt: '2026-08-01T00:00:00.000Z',
  pins: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      at: 1,
      kind: 'message' as const,
      blockId: 'block-a',
      blockKind: 'assistant' as const,
      preview: 'Saved answer',
      by: 'human' as const,
      createdBy: null,
      createdByName: null,
    },
  ],
};

const attention = {
  v: 1 as const,
  sessionId: 'session-a',
  items: [
    {
      id: 'A1',
      source: 'question' as const,
      sourceRef: null,
      subject: 'Question',
      why: 'Decision needed',
      waitingSince: '2026-08-01T00:00:00.000Z',
      howToResolve: 'Answer it',
      raisedBy: 'human' as const,
      raisedBySession: null,
      raisedByName: null,
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function PinsProbe({
  client,
  active,
  currentScope,
}: {
  client: DaemonPinClient;
  active: boolean;
  currentScope: typeof scope | null;
}) {
  const status = usePinsSession(client, daemon, currentScope);
  const board = useSessionPins(client, currentScope);
  const count = usePinCount(client, daemon, currentScope);
  const pinned = useMessagePinned(client, currentScope, 'block-a');
  const foreground = useForegroundPinScope();
  useDeclareForegroundPinScope(scope, active);
  return (
    <output>{`${status}:${board?.pins.length ?? 0}:${count}:${pinned}:${foreground?.sessionId ?? 'none'}`}</output>
  );
}

function AttentionProbe({
  client,
  currentScope,
}: {
  client: DaemonAttentionClient;
  currentScope: typeof scope | null;
}) {
  const status = useAttentionSession(client, daemon, currentScope);
  const board = useAttentionSnapshot(client, currentScope);
  const items = useAttentionItems(client, currentScope);
  const resolved = useAttentionResolutions(client, currentScope);
  const count = useAttentionCount(client, daemon, currentScope);
  return <output>{`${status}:${board?.count ?? 0}:${items.length}:${resolved.length}:${count}`}</output>;
}

const output = (renderer: ReturnType<typeof render>): string => renderer.root.findByType('output').children.join('');

describe('daemon-scoped PWA data hooks', () => {
  it('renders only the requested pin scope and synchronizes foreground lifecycle through React', () => {
    const client = new DaemonPinClient();
    client.store.applySnapshot(scope, pins);
    const probe = render(<PinsProbe client={client} active currentScope={scope} />);
    expect(output(probe)).toBe('ready:1:1:true:session-a');
    expect(getForegroundPinScope()).toEqual(scope);

    run(() => probe.update(<PinsProbe client={client} active={false} currentScope={null} />));
    expect(output(probe)).toBe('idle:0:0:false:none');
    expect(getForegroundPinScope()).toBeNull();
  });

  it('renders full and badge attention state from one exact scope, including the null-scope fallback', () => {
    const client = new DaemonAttentionClient();
    client.store.applySnapshot(scope, attention);
    const probe = render(<AttentionProbe client={client} currentScope={scope} />);
    expect(output(probe)).toBe('ready:1:1:0:1');

    run(() => probe.update(<AttentionProbe client={client} currentScope={null} />));
    expect(output(probe)).toBe('idle:0:0:0:0');
  });
});
