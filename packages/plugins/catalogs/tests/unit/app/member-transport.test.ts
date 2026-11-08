import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  DIRECT_MEMBER_DEADLINE_MS,
  type MemberCarriers,
  type MemberSocket,
  RELAY_CLOSE_CODES,
  RELAY_MEMBER_DEADLINE_MS,
  type RelayClientSession,
  RelayJoinRefusedError,
  RelaySessionError,
  WebCryptoRelayCrypto,
} from '@ferretry/app';
import { z } from 'zod';
import { MemberRefusedError, MemberUnreachableError } from '../../../app/lib/member-client.ts';
import { currentMemberTransport, memberTransportOver, noMemberTransport } from '../../../app/lib/member-transport.ts';
import type { ShareLinkSeed } from '../../../contract/wire/index.ts';

const SEED = {
  daemonId: `fy_daemon_${'a'.repeat(43)}`,
  daemonUrl: 'https://box.example.test',
  code: 'fy_share_aaaaaaaaaaaaaaaaaaaaaa',
} as unknown as ShareLinkSeed;
const RENDEZVOUS = 'wss://relay.example.test';
const KEYS = { signingKey: {} as CryptoKey, publicKey: 'pk', boxKey: 'bk' } as never;
const SUBSCRIPTION = {
  daemonId: SEED.daemonId,
  daemonUrl: SEED.daemonUrl,
  keyId: 'mk_x',
  signingKey: {},
  carriers: [],
} as never;

interface FakeSession {
  sent: boolean;
  closed: string[];
  requests: unknown[];
  asked: (record: unknown, signal?: AbortSignal) => Promise<unknown>;
  live: () => boolean;
  joined: () => Promise<unknown>;
  ready: () => Promise<unknown>;
  credentialSent: () => boolean;
  request: (record: unknown, signal?: AbortSignal) => Promise<unknown>;
  close: (reason: string) => void;
}

const fakeSession = (): FakeSession => {
  const session: FakeSession = {
    sent: false,
    closed: [],
    requests: [],
    asked: async () => ({ kind: 'response', status: 200, headers: {}, body: '{}' }),
    live: () => true,
    joined: () => new Promise(() => undefined),
    ready: () => new Promise(() => undefined),
    credentialSent: () => session.sent,
    request: (record, signal) => {
      session.requests.push(record);
      return session.asked(record, signal);
    },
    close: reason => void session.closed.push(reason),
  };
  return session;
};

type Drive = (step: number, session: FakeSession, kind: 'direct' | 'relay') => Promise<unknown>;

/** Fake carriers: records every dial and drive, and lets a test script each step. */
const harness = (drive: Drive, options: { dialThrows?: (kind: 'direct' | 'relay') => boolean } = {}) => {
  const dials: { kind: string; address: string }[] = [];
  const drives: { kind: string; deadlineMs: number; keepAlive: boolean }[] = [];
  const sessions: FakeSession[] = [];
  const sockets: { closed: number }[] = [];
  const carriers = {
    rendezvousUrl: RENDEZVOUS,
    dial: (kind, address) => {
      dials.push({ kind, address });
      if (options.dialThrows?.(kind) === true) throw new Error('this carrier cannot address the publisher');
      const socket = {
        closed: 0,
        close: () => {
          socket.closed += 1;
        },
      };
      sockets.push(socket);
      return socket as unknown as MemberSocket;
    },
    drive: (async (input: { kind: 'direct' | 'relay'; session: unknown; deadlineMs: number; keepAlive: boolean }) => {
      drives.push({ kind: input.kind, deadlineMs: input.deadlineMs, keepAlive: input.keepAlive });
      return await drive(drives.length - 1, input.session as FakeSession, input.kind);
    }) as MemberCarriers['drive'],
  } satisfies MemberCarriers;
  const transport = memberTransportOver(carriers, new WebCryptoRelayCrypto(), () => {
    const session = fakeSession();
    sessions.push(session);
    return session as unknown as RelayClientSession;
  });
  return { transport, dials, drives, sessions, sockets };
};

const joinedAnswer = {
  kind: 'joined',
  response: {
    memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
    keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
    label: 'Me',
    daemonId: SEED.daemonId,
    daemonName: 'Box',
    catalogCount: 1,
    carriers: [],
    passkeyWindowEndsAt: '2026-10-31T10:10:00.000Z',
    memberUnlockDays: 30,
  },
};

afterEach(() => {
  // nothing to restore: every spy below is restored by its own test
});

describe('the member transport fails closed', () => {
  it('reaches nobody while the shell offers no member carriers, and sends nothing', async () => {
    const transport = currentMemberTransport();
    expect(transport).toBe(noMemberTransport);
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 0,
    });
    expect(await transport.joinOptions({ seed: SEED, keys: KEYS })).toEqual({ kind: 'unreachable' });
    await expect(transport.openClient(SUBSCRIPTION)).rejects.toBeInstanceOf(MemberUnreachableError);
  });

  it('answers unreachable, with no step tried, for a fingerprint that is not a daemon id (nothing dialled)', async () => {
    const { transport, dials } = harness(async () => joinedAnswer);
    const bad = { ...SEED, daemonId: 'not-a-daemon-id' } as unknown as ShareLinkSeed;
    expect(await transport.join({ seed: bad, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 0,
    });
    expect(dials).toEqual([]);
  });
});

describe('S4 the walk, the deadlines and the persisted address are not the carrier’s to choose', () => {
  it('walks the app’s order with the app’s deadlines, whatever the carrier object also carries', async () => {
    const { transport, dials, drives } = harness(async () => {
      throw new RelaySessionError('closed', 1006);
    });
    await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(dials).toEqual([
      { kind: 'direct', address: SEED.daemonUrl },
      { kind: 'relay', address: RENDEZVOUS },
    ]);
    expect(drives.map(drive => drive.deadlineMs)).toEqual([DIRECT_MEMBER_DEADLINE_MS, RELAY_MEMBER_DEADLINE_MS]);
  });

  it('persists the publisher’s own address as the direct carrier, never a step address', async () => {
    const { transport } = harness(async () => joinedAnswer);
    const result = await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(result).toMatchObject({ kind: 'joined', carrier: { kind: 'direct', daemonUrl: SEED.daemonUrl } });
  });
});

describe('S1 a refusal is final: the code is not carried to the next carrier', () => {
  it('stops a join at a refusal after the first carrier', async () => {
    const { transport, dials } = harness(async () => {
      throw new RelayJoinRefusedError();
    });
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'refused',
      maybeSpentUnheard: false,
    });
    expect(dials).toHaveLength(1);
  });

  it('stops join-options at a refusal after the first carrier', async () => {
    const { transport, dials } = harness(async () => {
      throw new RelayJoinRefusedError();
    });
    expect(await transport.joinOptions({ seed: SEED, keys: KEYS })).toEqual({ kind: 'refused' });
    expect(dials).toHaveLength(1);
  });

  it('says the share may be spent when the code was sent and nothing answered, on every carrier', async () => {
    const { transport, dials } = harness(async (_step, session) => {
      session.sent = true;
      throw new RelaySessionError('closed before the answer', 1006);
    });
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: true,
      tried: 2,
    });
    expect(dials).toHaveLength(2);
  });

  it('does not say it may be spent when nothing was sent', async () => {
    const { transport } = harness(async () => {
      throw new RelaySessionError('never opened', 1006);
    });
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toMatchObject({
      kind: 'unreachable',
      maybeSpentUnheard: false,
    });
  });

  it('closes the socket of an attempt that ended', async () => {
    const { transport, sockets } = harness(async () => {
      throw new RelayJoinRefusedError();
    });
    await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(sockets[0]?.closed).toBe(1);
  });
});

describe('S2 a carrier that cannot address the publisher is skipped, not fatal', () => {
  it('moves on from a throwing dial to the next carrier in a join', async () => {
    const { transport, dials } = harness(async () => joinedAnswer, { dialThrows: kind => kind === 'direct' });
    const result = await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(dials.map(dial => dial.kind)).toEqual(['direct', 'relay']);
    expect(result).toMatchObject({ kind: 'joined', carrier: { kind: 'relay', relayUrl: RENDEZVOUS } });
  });

  it('answers unreachable (no rejection) when every dial throws, having sent nothing', async () => {
    const { transport, drives } = harness(async () => joinedAnswer, { dialThrows: () => true });
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 2,
    });
    expect(await transport.joinOptions({ seed: SEED, keys: KEYS })).toEqual({ kind: 'unreachable' });
    expect(drives).toEqual([]);
  });

  it('moves on from a throwing dial in a member session', async () => {
    const { transport, dials } = harness(async () => fakeSession(), { dialThrows: kind => kind === 'direct' });
    const client = await transport.openClient(SUBSCRIPTION);
    await client.request('/v1/shared/me', z.unknown());
    expect(dials.map(dial => dial.kind)).toEqual(['direct', 'relay']);
  });

  it('is unreachable, not a raw error, when every member dial throws', async () => {
    const { transport } = harness(async () => fakeSession(), { dialThrows: () => true });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberUnreachableError);
  });
});

describe('S1 a member session reads a refused key, replays only a read, and does not wait forever', () => {
  const answered = (status: number, body: unknown) => async () => ({
    kind: 'response',
    status,
    headers: {},
    body: JSON.stringify(body),
  });

  it('treats a 4403 on a new session as a refused key and stops walking', async () => {
    const { transport, dials } = harness(async () => {
      throw new RelaySessionError('refused', RELAY_CLOSE_CODES.authRejected);
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberRefusedError);
    expect(dials).toHaveLength(1);
  });

  it('reads a 401 unauthorized on an open session as the key being refused', async () => {
    const { transport } = harness(async (_step, session) => {
      session.asked = answered(401, { error: 'no', code: 'unauthorized' });
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberRefusedError);
  });

  it('keeps a publisher’s other refusal as its own error', async () => {
    const { transport } = harness(async (_step, session) => {
      session.asked = answered(403, { error: 'locked', code: 'member_locked' });
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toMatchObject({
      status: 403,
      code: 'member_locked',
    });
  });

  it('opens a new session after a lease ended, for a read', async () => {
    const { transport, sessions, drives } = harness(async (step, session) => {
      if (step === 0) {
        session.live = () => false; // an ended lease leaves a session that is no longer live
        session.asked = async () => {
          throw new RelaySessionError('lease ended', 4441);
        };
      }
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await client.request('/v1/shared/me', z.unknown());
    expect(drives).toHaveLength(2);
    expect(sessions[1]?.requests).toHaveLength(1);
  });

  it('does not replay a write after a lease ended', async () => {
    const { transport, drives } = harness(async (_step, session) => {
      session.asked = async () => {
        throw new RelaySessionError('lease ended', 4441);
      };
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/x', z.unknown(), { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      RelaySessionError,
    );
    expect(drives).toHaveLength(1);
  });

  it('drops the session and fails when the publisher does not answer in time', async () => {
    const abort = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => abort.signal);
    try {
      const { transport, sessions } = harness(async (_step, session) => {
        session.asked = (_record, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('timed out')));
          });
        return session;
      });
      const client = await transport.openClient(SUBSCRIPTION);
      const pending = client.request('/v1/shared/me', z.unknown());
      await new Promise(resolve => setTimeout(resolve, 0));
      abort.abort();
      await expect(pending).rejects.toThrow('timed out');
      expect(sessions[0]?.closed).toEqual(['the publisher did not answer a request in time']);
    } finally {
      timeout.mockRestore();
    }
  });

  it('close() ends the live session and refuses later requests without dialling', async () => {
    const { transport, sessions, dials } = harness(async (_step, session) => session);
    const client = await transport.openClient(SUBSCRIPTION);
    await client.request('/v1/shared/me', z.unknown());
    client.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sessions[0]?.closed).toEqual(['the member left this publisher']);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberUnreachableError);
    expect(dials).toHaveLength(1);
  });
});

describe('GAP(connections): guarantees that need the real carrier (ported with Connections’ dial and drive)', () => {
  it.todo('S1 the direct deadline stops a dial that never opens and the walk moves on (should not hang the join)');
  it.todo('S1 a relay leg is held to the heartbeat grace, never longer, whatever the carrier is told');
  it.todo('S1 a rendezvous that closes before it accepts the session is a transport failure, not a refusal');
  it.todo('S1 the heartbeat keeps a member session alive, and a session the carrier dropped is no longer live');
  it.todo('S1 a fingerprint that cannot address a session is refused by the pinned handshake before the code leaves');
});
