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
  /** The session's own sealed outcome, as the real one latches it. */
  finish: (value: unknown) => void;
  fail: (reason: unknown) => void;
}

const fakeSession = (): FakeSession => {
  let settle: (value: unknown) => void = () => undefined;
  let refuse: (reason: unknown) => void = () => undefined;
  const outcome = new Promise<unknown>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  outcome.catch(() => undefined);
  const session: FakeSession = {
    sent: false,
    closed: [],
    requests: [],
    asked: async () => ({ kind: 'response', status: 200, headers: {}, body: '{}' }),
    live: () => true,
    joined: () => outcome,
    ready: () => outcome,
    credentialSent: () => session.sent,
    request: (record, signal) => {
      session.requests.push(record);
      return session.asked(record, signal);
    },
    close: reason => void session.closed.push(reason),
    finish: value => settle(value),
    fail: reason => refuse(reason),
  };
  return session;
};

type Drive = (step: number, session: FakeSession, kind: 'direct' | 'relay') => Promise<unknown>;

interface HarnessOptions {
  dialThrows?: (kind: 'direct' | 'relay') => boolean;
  /**
   * A faithful carrier: whatever the scripted drive resolves or rejects with, the session settles with too. A test that
   * wants a carrier that LIES (wraps an error, invents a value, never returns) turns this off and settles the session itself.
   */
  mirror?: boolean;
  /** Throws instead of building the session of the nth build (0-based). */
  buildThrows?: (build: number) => boolean;
  /** The `daemonId` and `mode` every session was built with. */
  built?: { daemonId: string; kind: string }[];
}

/** Fake carriers: records every dial and drive, and lets a test script each step. */
const harness = (drive: Drive, options: HarnessOptions = {}) => {
  const dials: { kind: string; address: string }[] = [];
  const drives: { kind: string; deadlineMs: number; keepAlive: boolean }[] = [];
  const sessions: FakeSession[] = [];
  const sockets: { closed: number }[] = [];
  const built: { daemonId: string; kind: string }[] = options.built ?? [];
  const mirror = options.mirror ?? true;
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
      const session = input.session as FakeSession;
      try {
        const value = await drive(drives.length - 1, session, input.kind);
        if (mirror) session.finish(value);
        return value;
      } catch (reason) {
        if (mirror) session.fail(reason);
        throw reason;
      }
    }) as MemberCarriers['drive'],
  } satisfies MemberCarriers;
  let builds = 0;
  const transport = memberTransportOver(carriers, new WebCryptoRelayCrypto(), dependencies => {
    const build = builds;
    builds += 1;
    if (options.buildThrows?.(build) === true) throw new Error('the session could not be built');
    built.push({ daemonId: dependencies.daemonId, kind: dependencies.mode.kind });
    const session = fakeSession();
    sessions.push(session);
    return session as unknown as RelayClientSession;
  });
  return { transport, dials, drives, sessions, sockets, built };
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

  it('says only the status when the publisher refuses with a body that is not JSON', async () => {
    const { transport } = harness(async (_step, session) => {
      session.asked = async () => ({ kind: 'response', status: 502, headers: {}, body: '<html>Bad gateway</html>' });
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toMatchObject({
      status: 502,
      code: '',
      message: 'the publisher answered 502',
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
    const { transport, drives, sessions } = harness(async (_step, session) => {
      session.live = () => false; // as the GET case: an ended lease leaves a session that is no longer live
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
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.requests).toHaveLength(1);
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

describe('leaving a publisher while a session to it is still being opened', () => {
  it('lets the walk fail on its own: the request is unreachable, nothing is left unhandled, and later requests dial nothing', async () => {
    // Arrange: every carrier fails, but only once the test lets it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { transport, dials } = harness(async () => {
      await gate;
      throw new Error('this carrier failed');
    });
    const client = await transport.openClient(SUBSCRIPTION);
    const pending = client.request('/v1/shared/me', z.unknown());
    await new Promise(resolve => setTimeout(resolve, 0));

    // Act: the member leaves while the first carrier is still being tried.
    client.close();
    release();

    // Assert
    await expect(pending).rejects.toBeInstanceOf(MemberUnreachableError);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberUnreachableError);
    expect(dials.length).toBeGreaterThan(0);
    const dialled = dials.length;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dials).toHaveLength(dialled);
  });
});

describe('join-options answers a challenge as the proof options the publisher sent', () => {
  it('parses the options of a challenge, names the carrier that reached the publisher, and closes the socket', async () => {
    const options = {
      challenge: 'Y2hhbGxlbmdl',
      rpId: 'box.example.test',
      allowCredentials: [{ type: 'public-key', id: 'AQIDBA' }],
      timeout: 60_000,
    };
    const { transport, sockets } = harness(async () => ({ kind: 'challenge', memberLabel: 'Me', options }));
    const answered = await transport.joinOptions({ seed: SEED, keys: KEYS });
    expect(answered).toMatchObject({ kind: 'answer', answer: { kind: 'challenge', memberLabel: 'Me', options } });
    expect(sockets[0]?.closed).toBeGreaterThan(0);
  });

  it('refuses options that are not a challenge the schema knows, and walks on to the next carrier', async () => {
    const { transport, dials } = harness(async () => ({
      kind: 'challenge',
      memberLabel: 'Me',
      options: { challenge: 'Y2hhbGxlbmdl', allowCredentials: [] },
    }));
    expect(await transport.joinOptions({ seed: SEED, keys: KEYS })).toMatchObject({ kind: 'unreachable' });
    expect(dials.length).toBeGreaterThan(1);
  });
});

describe('R2-S1 this half holds the carrier to the deadline and decides finality from its own session', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  /** Runs the callback of a recorded `setTimeout` call now: the deadline passes. */
  const fire = (call: readonly unknown[] | undefined): void => {
    const callback = call?.[0];
    if (typeof callback !== 'function') throw new Error('no such deadline timer was set');
    callback();
  };
  const clock = async (milliseconds: number): Promise<void> =>
    await new Promise(resolve => setTimeout(resolve, milliseconds));

  it('stops a join on a carrier that ignores the deadline, closes socket and session, and moves on', async () => {
    const deadlines = spyOn(globalThis, 'setTimeout');
    try {
      const { transport, dials, sessions, sockets } = harness(
        async (step, session) => {
          if (step === 0) return await never(); // a drive that ignores deadlineMs
          session.finish(joinedAnswer);
          return joinedAnswer;
        },
        { mirror: false },
      );
      const pending = transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
      // The direct leg's own deadline is the app's walk deadline.
      const timer = deadlines.mock.calls.find(call => call[1] === DIRECT_MEMBER_DEADLINE_MS);
      expect(timer).toBeDefined();
      fire(timer);
      const result = await pending;
      expect(dials.map(dial => dial.kind)).toEqual(['direct', 'relay']);
      expect(sessions[0]?.closed).toHaveLength(1);
      expect(sockets[0]?.closed).toBeGreaterThanOrEqual(1);
      expect(result).toMatchObject({ kind: 'joined', carrier: { kind: 'relay', relayUrl: RENDEZVOUS } });
    } finally {
      deadlines.mockRestore();
    }
  });

  it('R3-N1 a join whose session settled does not wait for a drive that returns late', async () => {
    const { transport, dials } = harness(
      async (_step, session) => {
        session.finish(joinedAnswer);
        return await never(); // a drive that runs to the end of the session and so outlives the join
      },
      { mirror: false },
    );
    const pending = transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    // Well inside the 4 s deadline: the answer comes from the settled session, not from the drive or the timer.
    const first = await Promise.race([pending, clock(250).then(() => 'waited' as const)]);
    expect(first).not.toBe('waited');
    expect(first).toMatchObject({ kind: 'joined', carrier: { kind: 'direct' } });
    expect(dials.map(dial => dial.kind)).toEqual(['direct']);
  });

  it('reports a share that may be spent when the code was sent and the carrier then outlived its deadline', async () => {
    const deadlines = spyOn(globalThis, 'setTimeout');
    try {
      const { transport } = harness(
        async (_step, session) => {
          session.sent = true;
          return await never();
        },
        { mirror: false },
      );
      const pending = transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
      for (let leg = 0; leg < 2; leg += 1) {
        await clock(0);
        const timers = deadlines.mock.calls.filter(
          call => call[1] === DIRECT_MEMBER_DEADLINE_MS || call[1] === RELAY_MEMBER_DEADLINE_MS,
        );
        fire(timers[leg]);
      }
      expect(await pending).toEqual({ kind: 'unreachable', maybeSpentUnheard: true, tried: 2 });
    } finally {
      deadlines.mockRestore();
    }
  });

  it('stops a member session walk on a carrier that ignores the deadline and moves to the next', async () => {
    const deadlines = spyOn(globalThis, 'setTimeout');
    try {
      const { transport, dials } = harness(
        async (step, session) => {
          if (step === 0) return await never();
          session.finish(session);
          return session;
        },
        { mirror: false },
      );
      const client = await transport.openClient(SUBSCRIPTION);
      const pending = client.request('/v1/shared/me', z.unknown());
      const timer = deadlines.mock.calls.find(call => call[1] === DIRECT_MEMBER_DEADLINE_MS);
      fire(timer);
      await pending;
      expect(dials.map(dial => dial.kind)).toEqual(['direct', 'relay']);
    } finally {
      deadlines.mockRestore();
    }
  });

  it('a refusal the session sealed stays a refusal when drive rejects with a generic Error: one dial', async () => {
    const { transport, dials } = harness(
      async (_step, session) => {
        session.fail(new RelayJoinRefusedError());
        throw new Error('drive wrapped the failure');
      },
      { mirror: false },
    );
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'refused',
      maybeSpentUnheard: false,
    });
    expect(dials).toHaveLength(1);
  });

  it('the same holds for join-options and for a rejected member key', async () => {
    const options = harness(
      async (_step, session) => {
        session.fail(new RelayJoinRefusedError());
        throw new Error('drive wrapped the failure');
      },
      { mirror: false },
    );
    expect(await options.transport.joinOptions({ seed: SEED, keys: KEYS })).toEqual({ kind: 'refused' });
    expect(options.dials).toHaveLength(1);
    const member = harness(
      async (_step, session) => {
        session.fail(new RelaySessionError('refused', RELAY_CLOSE_CODES.authRejected));
        throw new Error('drive wrapped the failure');
      },
      { mirror: false },
    );
    const client = await member.transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberRefusedError);
    expect(member.dials).toHaveLength(1);
  });

  it('the joined value comes from the session, not from what drive resolves with', async () => {
    const { transport } = harness(
      async (_step, session) => {
        session.finish(joinedAnswer);
        return { kind: 'joined', response: { forged: true } };
      },
      { mirror: false },
    );
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toMatchObject({
      kind: 'joined',
      response: { memberId: joinedAnswer.response.memberId },
    });
  });

  it('a drive that resolves while the session has not settled is not a join', async () => {
    const { transport, sessions } = harness(async () => joinedAnswer, { mirror: false });
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 2,
    });
    expect(sessions.every(session => session.closed.length === 1)).toBe(true);
  });

  it('the member session is the one this half built, not what drive resolves with', async () => {
    const forged = fakeSession();
    const { transport, sessions } = harness(
      async (_step, session) => {
        session.finish(session);
        return forged;
      },
      { mirror: false },
    );
    const client = await transport.openClient(SUBSCRIPTION);
    await client.request('/v1/shared/me', z.unknown());
    expect(sessions[0]?.requests).toHaveLength(1);
    expect(forged.requests).toHaveLength(0);
  });
});

describe('R2-N2 a dialled socket is closed when building the session throws', () => {
  it('closes the socket in a join, and in join-options, and the walk goes on', async () => {
    const join = harness(async () => joinedAnswer, { buildThrows: build => build === 0 });
    const result = await join.transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(join.sockets[0]?.closed).toBe(1);
    expect(result).toMatchObject({ kind: 'joined', carrier: { kind: 'relay' } });
    const options = harness(async () => ({ kind: 'open', why: 'first-browser' }), {
      buildThrows: build => build === 0,
    });
    expect(await options.transport.joinOptions({ seed: SEED, keys: KEYS })).toMatchObject({ kind: 'answer' });
    expect(options.sockets[0]?.closed).toBe(1);
  });
});

describe('R2-S2 the session is pinned to the publisher’s fingerprint', () => {
  it('builds every join, join-options and member session with the seed’s or the subscription’s own daemon id', async () => {
    const join = harness(async () => joinedAnswer);
    await join.transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(join.built).toEqual([{ daemonId: SEED.daemonId, kind: 'join' }]);
    const options = harness(async () => ({ kind: 'open', why: 'first-browser' }));
    await options.transport.joinOptions({ seed: SEED, keys: KEYS });
    expect(options.built).toEqual([{ daemonId: SEED.daemonId, kind: 'join-options' }]);
    const member = harness(async (_step, session) => session);
    const client = await member.transport.openClient(SUBSCRIPTION);
    await client.request('/v1/shared/me', z.unknown());
    expect(member.built).toEqual([{ daemonId: SEED.daemonId, kind: 'member' }]);
  });

  it('keeps that id on every leg, whichever carrier the walk reaches', async () => {
    const { transport, built } = harness(async () => {
      throw new RelaySessionError('closed', 1006);
    });
    await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS });
    expect(built.map(entry => entry.daemonId)).toEqual([SEED.daemonId, SEED.daemonId]);
  });
});

describe('R2-S2 which 401 and which close mean the key is refused', () => {
  const answered = (status: number, body: unknown) => async () => ({
    kind: 'response',
    status,
    headers: {},
    body: JSON.stringify(body),
  });

  it('does not read any other 401 as a refused key', async () => {
    const { transport } = harness(async (_step, session) => {
      session.asked = answered(401, { error: 'that passkey did not check out', code: 'member_not_verified' });
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    const reason = await client.request('/v1/shared/unlock', z.unknown(), { method: 'POST' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(reason).not.toBeInstanceOf(MemberRefusedError);
    expect(reason).toMatchObject({ status: 401, code: 'member_not_verified' });
  });

  it('reads a 4403 that ends an open session as the key being refused', async () => {
    const { transport } = harness(async (_step, session) => {
      session.asked = async () => {
        throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
      };
      return session;
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', z.unknown())).rejects.toBeInstanceOf(MemberRefusedError);
  });
});

describe('GAP(connections): guarantees that need the real carrier (ported with Connections’ dial and drive)', () => {
  it.todo(
    'S1 the carrier’s own dial timeout: a dial that never opens is closed by the real carrier (this half’s deadline is covered above)',
  );
  it.todo('S1 a rendezvous that closes before it accepts the session is a transport failure, not a refusal');
  it.todo('S1 the heartbeat keeps a member session alive, and a session the carrier dropped is no longer live');
});
