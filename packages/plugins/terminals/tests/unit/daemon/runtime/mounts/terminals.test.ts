import { describe, it } from 'bun:test';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import {
  CloseFinishedTerminalsResponseSchema,
  CloseTerminalResponseSchema,
  TerminalHoldersViewSchema,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '../../../../../contract/index.ts';
import { TerminalRuntimeError } from '../../../../../daemon/adapters/terminal/index.ts';
import { ferretSummary } from '../../../../support/daemon/half.ts';
import { type Caller, FERRET, jsonBody, type MountHalf, mountHalf } from './support.ts';

/**
 * The terminal lifecycle's HTTP surface, driven through the kernel's test host and Terminals' real half.
 *
 * The tmux pane is replaced; the sizing, titling and idle policies behind every answer are the
 * production ones, and every response is validated against the contract schema before a case looks
 * at it — an answer the wire would reject is a failure however plausible it reads.
 */

const BASE = `/v1/ferrets/${FERRET}/terminals`;

const post = async (half: MountHalf, path: string, body?: unknown, as: Caller = 'owner') =>
  await half.call('POST', path, body, as);
const get = async (half: MountHalf, path: string, as: Caller = 'owner') => await half.call('GET', path, undefined, as);

/** Opens one terminal and hands back the half that owns it. */
async function withTerminal(half?: MountHalf): Promise<{ readonly half: MountHalf; readonly terminal: TerminalView }> {
  const owned = half ?? (await mountHalf());
  const created = await post(owned, BASE);
  should(created.status).equal(201);
  return { half: owned, terminal: TerminalViewSchema.parse(jsonBody(created)) };
}

describe('the terminal mount', () => {
  describe('opening a terminal', () => {
    it('should open one with a default title and size when the body is empty', async () => {
      // A PWA button sends no body at all: every field is optional, so that means "you choose".
      // Arrange / Act
      const { terminal } = await withTerminal();

      // Assert
      should(terminal.title).equal('Terminal 1');
      should([terminal.cols, terminal.rows]).deepEqual([100, 30]);
      should(terminal.sessionId).equal(FERRET);
    });

    it('should honour the title and size the caller asked for', async () => {
      // Arrange
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, { title: 'Build watch', cols: 120, rows: 40 });

      // Assert
      should(created.status).equal(201);
      const view = TerminalViewSchema.parse(jsonBody(created));
      should(view.title).equal('Build watch');
      should([view.cols, view.rows]).deepEqual([120, 40]);
    });

    it('should number the second terminal after the first', async () => {
      // Arrange
      const { half } = await withTerminal();

      // Act
      const second = await post(half, BASE);

      // Assert
      should(TerminalViewSchema.parse(jsonBody(second)).title).equal('Terminal 2');
    });

    it('should record the local credential as the opener when nothing else is claimed', async () => {
      // Arrange / Act
      const { terminal } = await withTerminal();

      // Assert
      should(terminal.openedBy).deepEqual({ by: 'local' });
    });

    it('should record the agent a local caller opened the terminal for', async () => {
      // This is #34's whole point: a reader must be able to see, on the row
      // itself, that an agent is driving this shell before typing into it.
      // Arrange
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, { agentSessionId: 'mse7wwti-2a75bd9c' });

      // Assert
      should(created.status).equal(201);
      should(TerminalViewSchema.parse(jsonBody(created)).openedBy).deepEqual({
        by: 'agent',
        sessionId: 'mse7wwti-2a75bd9c',
      });
    });

    it('should record a paired device as the human holding it', async () => {
      // Arrange — the device credential is the one a phone or a browser presents.
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, undefined, 'device');

      // Assert
      should(created.status).equal(201);
      should(TerminalViewSchema.parse(jsonBody(created)).openedBy).deepEqual({ by: 'human', deviceId: 'device-1' });
    });

    it('should refuse a paired device that asks to be recorded as an agent', async () => {
      // A device is a human by construction. Letting one label its own shell as
      // an agent's would make every agent badge unreadable, and recording it as
      // a human anyway would hide that the caller asked for something else.
      // Arrange
      const half = await mountHalf();

      // Act
      const refused = await post(half, BASE, { agentSessionId: 'mse7wwti' }, 'device');
      const listed = await get(half, BASE);

      // Assert
      should(refused.status).equal(403);
      should(jsonBody(refused)).have.property('code', 'forbidden');
      // Refused means NOT OPENED: a shell must never outlive the refusal that
      // was meant to prevent it.
      should(TerminalListViewSchema.parse(jsonBody(listed)).terminals).be.empty();
    });

    it('should refuse an agent identity the wire could not carry', async () => {
      // Arrange
      const half = await mountHalf();

      // Act
      const refused = await post(half, BASE, { agentSessionId: 'not a session' });

      // Assert
      should(refused.status).equal(403);
    });

    it('should open a shell with its ownership left blank when a device id cannot be put on the wire', async () => {
      // A device id the protocol cannot represent is no reason to refuse the shell, but it is a reason
      // not to print an owner nobody could render: the terminal opens unrecorded.
      // Arrange
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, undefined, 'odd-device');

      // Assert
      should(created.status).equal(201);
      should(TerminalViewSchema.parse(jsonBody(created)).openedBy).be.undefined();
    });

    it('should refuse a size the protocol does not allow', async () => {
      // Arrange
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, { cols: 5, rows: 5 });

      // Assert
      should(created.status).equal(400);
      should(jsonBody(created)).have.property('code', 'invalid_request');
    });

    it('should refuse a field the protocol does not define rather than ignore it', async () => {
      // `strictObject` is what makes a typo in a client an error instead of a silently dropped
      // request — a caller that asked for a shell and got the default would never know.
      // Arrange
      const half = await mountHalf();

      // Act
      const created = await post(half, BASE, { shell: '/bin/zsh' });

      // Assert
      should(created.status).equal(400);
    });

    it('should report a full session as a conflict, not a bad request', async () => {
      // The request was well formed; the fleet's own state is what refused it, so a client can tell
      // "close one and retry" apart from "you asked wrongly".
      // Arrange
      const half = await mountHalf({ config: { 'terminals.yaml': { perFerret: 1 } } });
      await post(half, BASE);

      // Act
      const refused = await post(half, BASE);

      // Assert
      should(refused.status).equal(409);
      should(jsonBody(refused)).have.property('code', 'capacity');
    });
  });

  describe('reading terminals', () => {
    it('should list a session‘s terminals with the limits it is held to', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const listed = await get(half, BASE);

      // Assert
      should(listed.status).equal(200);
      const view = TerminalListViewSchema.parse(jsonBody(listed));
      should(view.terminals.map(row => row.id)).deepEqual([terminal.id]);
      should(view.limits.perSession).equal(6);
      should(view.limits.global).equal(24);
    });

    it('should read one terminal back by id', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const detail = await get(half, `${BASE}/${terminal.id}`);

      // Assert
      should(detail.status).equal(200);
      should(TerminalViewSchema.parse(jsonBody(detail)).id).equal(terminal.id);
    });

    it('should report a session it cannot resolve as not found', async () => {
      // Arrange
      const half = await mountHalf();

      // Act
      const listed = await get(half, '/v1/ferrets/absent/terminals');

      // Assert
      should(listed.status).equal(404);
      should(jsonBody(listed)).have.property('code', 'not_found');
    });

    it('should refuse an id that could never name a terminal it minted', async () => {
      // A twelve-hex id is the protocol's shape. Looking up anything else and answering 404 would
      // read as "it was closed" when the caller in fact asked a malformed question.
      // Arrange
      const half = await mountHalf();

      // Act
      const detail = await get(half, `${BASE}/zzz`);

      // Assert
      should(detail.status).equal(400);
      should(jsonBody(detail)).have.property('code', 'bad_request');
    });

    it('should refuse a path parameter that decodes to nothing usable', async () => {
      // Arrange
      const half = await mountHalf();

      // Act
      const listed = await get(half, '/v1/ferrets/%2e%2e/terminals');

      // Assert
      should(listed.status).equal(400);
      should(jsonBody(listed)).have.property('code', 'invalid_session_id');
    });
  });

  describe('retitling and closing', () => {
    it('should retitle a terminal and report the new title', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const renamed = await half.call('PATCH', `${BASE}/${terminal.id}`, { title: 'Deploy log' });

      // Assert
      should(renamed.status).equal(200);
      should(TerminalViewSchema.parse(jsonBody(renamed)).title).equal('Deploy log');
    });

    it('should not serve a retitle sent as POST, the method the app does not use', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const renamed = await post(half, `${BASE}/${terminal.id}`, { title: 'Deploy log' });

      // Assert
      should(renamed.status).equal(405);
      should(jsonBody(renamed)).have.property('code', 'method_not_allowed');
    });

    it('should refuse a title of control characters', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const renamed = await half.call('PATCH', `${BASE}/${terminal.id}`, { title: 'a\u0007b' });

      // Assert
      should(renamed.status).equal(400);
    });

    it('should close a terminal and stop listing it', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();

      // Act
      const closed = await half.call('DELETE', `${BASE}/${terminal.id}`);
      const listed = await get(half, BASE);

      // Assert
      should(closed.status).equal(200);
      should(CloseTerminalResponseSchema.parse(jsonBody(closed))).deepEqual({ closed: true, id: terminal.id });
      should(TerminalListViewSchema.parse(jsonBody(listed)).terminals).be.empty();
    });

    it('should report closing a terminal that is already gone as not found', async () => {
      // Arrange
      const { half, terminal } = await withTerminal();
      await half.call('DELETE', `${BASE}/${terminal.id}`);

      // Act
      const again = await half.call('DELETE', `${BASE}/${terminal.id}`);

      // Assert
      should(again.status).equal(404);
    });
  });

  describe('how failures are reported', () => {
    it('should report a tmux failure as an upstream failure, not as the caller‘s fault', async () => {
      // Arrange
      const half = await mountHalf();
      half.runtime.listFails = new TerminalRuntimeError('tmux command failed');

      // Act
      const listed = await get(half, BASE);

      // Assert
      should(listed.status).equal(502);
      should(jsonBody(listed)).have.property('code', 'upstream_failed');
    });

    it('should let a genuine defect become a 500 rather than blame the caller', async () => {
      // Arrange
      const half = await mountHalf();
      half.runtime.listFails = new Error('the session index is closed');

      // Act
      const listed = await get(half, BASE);

      // Assert
      should(listed.status).equal(500);
    });

    it('should refuse a warden-scoped caller: a terminal is an unsupervised shell', async () => {
      // Arrange / Act
      const listed = await get(await mountHalf(), BASE, 'warden');

      // Assert
      should(listed.status).equal(403);
    });
  });
});

describe('the owner’s view of the terminal slots', () => {
  const holder = { sessionId: 's-1', label: 'fitzgerald', standing: 'finished', status: 'stopped', count: 6 } as const;

  /** Six terminals left open by a ferret that has stopped. */
  async function heldByAStoppedFerret(): Promise<MountHalf> {
    const stopped: FerretSummary = {
      ...ferretSummary('s-1' as FerretId),
      name: 'fitzgerald',
      state: 'stopped',
    } as FerretSummary;
    const half = await mountHalf({ ferrets: [ferretSummary(), stopped] });
    for (let at = 0; at < 6; at += 1)
      await half.runtime.create({
        ownerId: 's-1',
        id: `00000000000${String(at)}`,
        title: `Terminal ${String(at + 1)}`,
        cwd: '/work/fitzgerald',
        size: { cols: 100, rows: 30 },
      });
    return half;
  }

  it('should say who holds the open terminals and what the limit is', async () => {
    // Arrange
    const half = await heldByAStoppedFerret();

    // Act
    const answered = await get(half, '/v1/terminals');

    // Assert
    should(answered.status).equal(200);
    should(TerminalHoldersViewSchema.parse(jsonBody(answered))).deepEqual({ limit: 24, open: 6, holders: [holder] });
  });

  it('should close the finished ferrets’ terminals as the owner and report who held them', async () => {
    // Arrange
    const half = await heldByAStoppedFerret();

    // Act
    const answered = await post(half, '/v1/terminals/close-finished');

    // Assert
    should(answered.status).equal(200);
    should(CloseFinishedTerminalsResponseSchema.parse(jsonBody(answered))).deepEqual({
      closed: 6,
      failed: 0,
      holders: [holder],
    });
    // The closing is said with its trigger: the owner, not a sweep.
    should(
      half.host.logs.filter(entry => entry.message === 'terminals closed').map(entry => entry.fields?.trigger),
    ).deepEqual(['owner']);
  });

  it('should report a failing tmux as an upstream failure on both routes', async () => {
    // Arrange
    const half = await mountHalf();
    half.runtime.listFails = new TerminalRuntimeError('tmux command failed');

    // Act
    const read = await get(half, '/v1/terminals');
    const closed = await post(half, '/v1/terminals/close-finished');

    // Assert
    should([read.status, closed.status]).deepEqual([502, 502]);
  });

  it('should refuse a warden-scoped caller, as for every other terminal route', async () => {
    // Arrange / Act
    const answered = await get(await mountHalf(), '/v1/terminals', 'warden');

    // Assert
    should(answered.status).equal(403);
  });
});

/**
 * The terminal STREAM's surface — a protocol switch rather than a response.
 *
 * These cases exist to prove the one property that cannot be retrofitted: everything a client could
 * be told with a status is settled BEFORE the socket exists. A stream that upgraded and then closed
 * could not tell a viewer "there is no such terminal" from "the daemon broke", and would let an
 * unauthorized peer map which terminals exist by watching how fast each socket died.
 */
describe('the mounted terminal stream', () => {
  const frames = (socket: { readonly frames: readonly (string | Uint8Array)[] } | undefined): string =>
    (socket?.frames ?? []).map(frame => (typeof frame === 'string' ? frame : new TextDecoder().decode(frame))).join('');

  it('should attach a viewer to a terminal that exists', async () => {
    // Arrange
    const { half, terminal } = await withTerminal();

    // Act
    const opened = await half.stream(`${BASE}/${terminal.id}/stream`);

    // Assert — accepted, and the viewer is drawn that terminal's own screen.
    should(opened.status).be.undefined();
    should(opened.socket?.handler).not.be.undefined();
    should(frames(opened.socket)).containEql('$');
    opened.socket?.handler?.close();
  });

  it('should refuse a stream for a terminal that was never opened, before switching protocols', async () => {
    // Arrange / Act
    const refused = await (await mountHalf()).stream(`${BASE}/0123456789ab/stream`);

    // Assert
    should(refused.socket).be.undefined();
    should(refused.status).equal(404);
    should(refused.code).equal('not_found');
  });

  it('should refuse a stream for a session this daemon does not hold', async () => {
    // Arrange / Act
    const refused = await (await mountHalf()).stream('/v1/ferrets/nope/terminals/0123456789ab/stream');

    // Assert
    should(refused.status).equal(404);
  });

  it('should refuse a terminal id that could not name a terminal this daemon minted', async () => {
    // Parsed against the protocol's own shape rather than looked up, so a crafted id is a bad request
    // instead of a 404 a viewer would read as "it was closed".
    // Arrange / Act
    const refused = await (await mountHalf()).stream(`${BASE}/not-a-terminal/stream`);

    // Assert
    should(refused.status).equal(400);
    should(refused.code).equal('bad_request');
  });

  it('should refuse an unauthenticated viewer, and a warden-scoped one', async () => {
    // A terminal socket carries keystrokes into an unsupervised shell — strictly more authority than
    // opening one — so the scope answer must match the lifecycle's.
    // Arrange
    const { half, terminal } = await withTerminal();
    const path = `${BASE}/${terminal.id}/stream`;

    // Act
    const anonymous = await half.stream(path, 'anonymous');
    const warden = await half.stream(path, 'warden');

    // Assert
    should(anonymous.status).equal(401);
    should(warden.status).equal(403);
    // Nothing was attached: an unauthorized peer never reaches a terminal.
    should(anonymous.socket).be.undefined();
    should(warden.socket).be.undefined();
  });
});
