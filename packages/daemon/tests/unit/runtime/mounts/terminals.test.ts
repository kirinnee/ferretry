import { describe, it } from 'bun:test';
import {
  CloseTerminalResponseSchema,
  TerminalListViewSchema,
  TerminalViewSchema,
  type TerminalView,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { terminalRoutes, TerminalMountError } from '../../../../src/lib/runtime/mounts/terminals.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, FakeTerminals, human } from './support.ts';

/**
 * The terminal lifecycle's HTTP surface, driven through the real router.
 *
 * The tmux pane is replaced; the sizing, titling and idle policies behind every answer are the
 * production ones, and every response is validated against the protocol schema before a case looks
 * at it — an answer the wire would reject is a failure however plausible it reads.
 */

function dispatcher(terminals: FakeTerminals = new FakeTerminals()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(terminalRoutes(terminals)), CREDENTIALS);
}

const post = (path: string, body?: unknown, headers: Readonly<Record<string, string>> = human) =>
  request({
    method: 'POST',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  });

/** Opens one terminal and hands back the dispatcher that owns it. */
async function withTerminal(
  terminals: FakeTerminals = new FakeTerminals(),
): Promise<{ readonly dispatch: ApiDispatcher; readonly terminal: TerminalView }> {
  const dispatch = dispatcher(terminals);
  const created = await dispatch.dispatch(post('/v1/sessions/s1/terminals'));
  should(created.status).equal(201);
  return { dispatch, terminal: TerminalViewSchema.parse(jsonBody(created)) };
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
      should(terminal.sessionId).equal('s1');
    });

    it('should honour the title and size the caller asked for', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const created = await dispatch.dispatch(
        post('/v1/sessions/s1/terminals', { title: 'Build watch', cols: 120, rows: 40 }),
      );

      // Assert
      should(created.status).equal(201);
      const view = TerminalViewSchema.parse(jsonBody(created));
      should(view.title).equal('Build watch');
      should([view.cols, view.rows]).deepEqual([120, 40]);
    });

    it('should number the second terminal after the first', async () => {
      // Arrange
      const { dispatch } = await withTerminal();

      // Act
      const second = await dispatch.dispatch(post('/v1/sessions/s1/terminals'));

      // Assert
      should(TerminalViewSchema.parse(jsonBody(second)).title).equal('Terminal 2');
    });

    it('should refuse a size the protocol does not allow', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const created = await dispatch.dispatch(post('/v1/sessions/s1/terminals', { cols: 5, rows: 5 }));

      // Assert
      should(created.status).equal(400);
      should(jsonBody(created)).have.property('code', 'invalid_request');
    });

    it('should refuse a field the protocol does not define rather than ignore it', async () => {
      // `strictObject` is what makes a typo in a client an error instead of a silently dropped
      // request — a caller that asked for a shell and got the default would never know.
      // Arrange
      const dispatch = dispatcher();

      // Act
      const created = await dispatch.dispatch(post('/v1/sessions/s1/terminals', { shell: '/bin/zsh' }));

      // Assert
      should(created.status).equal(400);
    });

    it('should report a full session as a conflict, not a bad request', async () => {
      // The request was well formed; the fleet's own state is what refused it, so a client can tell
      // "close one and retry" apart from "you asked wrongly".
      // Arrange
      const dispatch = dispatcher(new FakeTerminals(['s1'], 1));
      await dispatch.dispatch(post('/v1/sessions/s1/terminals'));

      // Act
      const refused = await dispatch.dispatch(post('/v1/sessions/s1/terminals'));

      // Assert
      should(refused.status).equal(409);
      should(jsonBody(refused)).have.property('code', 'capacity');
    });
  });

  describe('reading terminals', () => {
    it('should list a session‘s terminals with the limits it is held to', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();

      // Act
      const listed = await dispatch.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));

      // Assert
      should(listed.status).equal(200);
      const view = TerminalListViewSchema.parse(jsonBody(listed));
      should(view.terminals.map(row => row.id)).deepEqual([terminal.id]);
      should(view.limits.perSession).equal(6);
      should(view.limits.global).equal(24);
    });

    it('should read one terminal back by id', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();

      // Act
      const detail = await dispatch.dispatch(
        request({ path: `/v1/sessions/s1/terminals/${terminal.id}`, headers: human }),
      );

      // Assert
      should(detail.status).equal(200);
      should(TerminalViewSchema.parse(jsonBody(detail)).id).equal(terminal.id);
    });

    it('should report a session it cannot resolve as not found', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const listed = await dispatch.dispatch(request({ path: '/v1/sessions/absent/terminals', headers: human }));

      // Assert
      should(listed.status).equal(404);
      should(jsonBody(listed)).have.property('code', 'not_found');
    });

    it('should refuse an id that could never name a terminal it minted', async () => {
      // A twelve-hex id is the protocol's shape. Looking up anything else and answering 404 would
      // read as "it was closed" when the caller in fact asked a malformed question.
      // Arrange
      const dispatch = dispatcher();

      // Act
      const detail = await dispatch.dispatch(request({ path: '/v1/sessions/s1/terminals/zzz', headers: human }));

      // Assert
      should(detail.status).equal(400);
      should(jsonBody(detail)).have.property('code', 'bad_request');
    });

    it('should refuse a path parameter that decodes to nothing usable', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const listed = await dispatch.dispatch(request({ path: '/v1/sessions/%2e%2e/terminals', headers: human }));

      // Assert
      should(listed.status).equal(400);
      should(jsonBody(listed)).have.property('code', 'invalid_session_id');
    });
  });

  describe('retitling and closing', () => {
    it('should retitle a terminal and report the new title', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();

      // Act
      const renamed = await dispatch.dispatch(
        post(`/v1/sessions/s1/terminals/${terminal.id}`, { title: 'Deploy log' }),
      );

      // Assert
      should(renamed.status).equal(200);
      should(TerminalViewSchema.parse(jsonBody(renamed)).title).equal('Deploy log');
    });

    it('should refuse a title of control characters', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();

      // Act
      const renamed = await dispatch.dispatch(post(`/v1/sessions/s1/terminals/${terminal.id}`, { title: 'a\u0007b' }));

      // Assert
      should(renamed.status).equal(400);
    });

    it('should close a terminal and stop listing it', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();

      // Act
      const closed = await dispatch.dispatch(
        request({ method: 'DELETE', path: `/v1/sessions/s1/terminals/${terminal.id}`, headers: human }),
      );
      const listed = await dispatch.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));

      // Assert
      should(closed.status).equal(200);
      should(CloseTerminalResponseSchema.parse(jsonBody(closed))).deepEqual({ closed: true, id: terminal.id });
      should(TerminalListViewSchema.parse(jsonBody(listed)).terminals).be.empty();
    });

    it('should report closing a terminal that is already gone as not found', async () => {
      // Arrange
      const { dispatch, terminal } = await withTerminal();
      await dispatch.dispatch(
        request({ method: 'DELETE', path: `/v1/sessions/s1/terminals/${terminal.id}`, headers: human }),
      );

      // Act
      const again = await dispatch.dispatch(
        request({ method: 'DELETE', path: `/v1/sessions/s1/terminals/${terminal.id}`, headers: human }),
      );

      // Assert
      should(again.status).equal(404);
    });
  });

  describe('how failures are reported', () => {
    it('should report a tmux failure as an upstream failure, not as the caller‘s fault', async () => {
      // Arrange
      const failing = new ApiDispatcher(
        new ApiRouter(
          terminalRoutes({
            list: async () => {
              throw new TerminalMountError('upstream_failed', 'tmux command failed');
            },
            create: async () => {
              throw new Error('unreachable');
            },
            get: async () => {
              throw new Error('unreachable');
            },
            rename: async () => {
              throw new Error('unreachable');
            },
            close: async () => {
              throw new Error('unreachable');
            },
          }),
        ),
        CREDENTIALS,
      );

      // Act
      const listed = await failing.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));

      // Assert
      should(listed.status).equal(502);
      should(jsonBody(listed)).have.property('code', 'upstream_failed');
    });

    it('should let a genuine defect become a 500 rather than blame the caller', async () => {
      // Arrange
      const broken = new ApiDispatcher(
        new ApiRouter(
          terminalRoutes({
            list: async () => {
              throw new Error('the session index is closed');
            },
            create: async () => {
              throw new Error('unreachable');
            },
            get: async () => {
              throw new Error('unreachable');
            },
            rename: async () => {
              throw new Error('unreachable');
            },
            close: async () => {
              throw new Error('unreachable');
            },
          }),
        ),
        CREDENTIALS,
      );

      // Act
      const listed = await broken.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));

      // Assert
      should(listed.status).equal(500);
    });

    it('should refuse a warden-scoped caller: a terminal is an unsupervised shell', async () => {
      // Arrange / Act
      const listed = await dispatcher().dispatch(
        request({
          path: '/v1/sessions/s1/terminals',
          headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' },
        }),
      );

      // Assert
      should(listed.status).equal(403);
    });
  });
});
