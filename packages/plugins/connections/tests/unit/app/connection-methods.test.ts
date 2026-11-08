/** The app copy of the connection methods: which relay endpoints a browser may store, and how a walk is told. */
import { describe, expect, it } from 'bun:test';
import {
  chooseConnection,
  type ConnectionMethod,
  ConnectionMethodSchema,
  type ConnectionProbe,
} from '../../../app/lib/connection.ts';

const relayWith = (relayUrl: string) => ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl });
const issueOf = (relayUrl: string): string | undefined => {
  const result = relayWith(relayUrl);
  return result.success ? undefined : result.error.issues[0]?.message;
};

describe('a relay endpoint a browser will store', () => {
  it('keeps a secure endpoint, without its trailing slash', () => {
    const parsed = relayWith('wss://relay.example/');
    expect(parsed.success && parsed.data).toEqual({ kind: 'relay', relayUrl: 'wss://relay.example' });
  });

  it('refuses text that is not a URL', () => {
    expect(issueOf('not a url')).toBe('endpoint is not a URL');
  });

  it('refuses an insecure endpoint that is not on the loopback address', () => {
    expect(issueOf('http://relay.example')).toContain('endpoint must be wss/https');
  });

  it('refuses an endpoint that carries a query or a fragment', () => {
    expect(issueOf('wss://relay.example/path?token=1')).toBe('endpoint carries a query or fragment');
    expect(issueOf('wss://relay.example/path#frag')).toBe('endpoint carries a query or fragment');
  });
});

describe('choosing a connection from what was tried', () => {
  const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.example' };
  const relay: ConnectionMethod = { kind: 'relay', relayUrl: 'wss://relay.example' };

  it('says no method is configured when nothing was tried', () => {
    expect(chooseConnection([])).toEqual({
      ok: false,
      reason: 'No connection method is configured for this daemon.',
      passedOver: [],
    });
  });

  it('says every carrier it passed over, and why, when none worked', () => {
    const probes: ConnectionProbe[] = [
      { method: direct, reachable: false, detail: 'timed out' },
      { method: relay, reachable: false, detail: 'no dialer in this build', untried: true },
    ];
    const choice = chooseConnection(probes);
    expect(choice.ok).toBe(false);
    expect(choice.reason).toStartWith('No configured connection worked: ');
    expect(choice.reason).toContain('was not reachable (timed out)');
    expect(choice.reason).toContain('was not tried (no dialer in this build)');
    expect(choice.passedOver).toHaveLength(2);
  });
});
