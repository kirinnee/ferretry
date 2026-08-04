/**
 * Session-view fixtures for the shell suites.
 *
 * The shell renders sessions constantly (status glyphs, sidebar rows, the
 * palette), and every one of those suites needs the same shape. Building it
 * once here keeps the assertions about the component rather than about the
 * seventeen fields a `SessionView` happens to carry.
 */

import type { SessionConfig, SessionState, SessionView } from '@ferretry/protocol';

export interface SessionFixtureOverrides {
  readonly config?: Partial<SessionConfig>;
  readonly state?: Partial<SessionState>;
  readonly directory?: string;
}

/** A running `auto` session, overridable field by field. */
export const sessionView = (id: string, overrides: SessionFixtureOverrides = {}): SessionView =>
  ({
    config: {
      id,
      name: `Session ${id}`,
      agent: 'claude',
      harness: 'claude',
      modelHint: 'claude-opus-5',
      mode: 'auto',
      cwd: `/work/${id}`,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
      ...overrides.config,
    },
    state: {
      id,
      status: 'running',
      turn: 4,
      lastActivityAt: '1970-01-01T00:00:01.000Z',
      ...overrides.state,
    },
    directory: overrides.directory ?? `/work/${id}`,
  }) as unknown as SessionView;
