import type { IFyApiClient, IFyHttpTransport, TaskLive, TaskSummary, TaskView } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';

export interface Exchange {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * A transport that answers from a queue instead of a socket. It is the whole daemon as far as these
 * tests are concerned: no port is bound, no `fyd` is started.
 */
export class FakeTransport implements IFyHttpTransport {
  readonly exchanges: Exchange[] = [];

  constructor(private readonly replies: unknown[]) {}

  send(url: string, init: RequestInit): Promise<Response> {
    const raw = init.body;
    this.exchanges.push({
      url,
      method: init.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    });
    const reply = this.replies.shift();
    return Promise.resolve(
      new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }
}

export function fakeClient(replies: unknown[]): { client: Promise<IFyApiClient>; transport: FakeTransport } {
  const transport = new FakeTransport(replies);
  return {
    client: FyApiClient.connect({
      baseUrl: 'http://127.0.0.1:65535',
      token: 'test-token',
      version: '1.0.0',
      transport,
    }),
    transport,
  };
}

const quietLive: TaskLive = {
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
};

export function taskView(id = 'F1'): TaskView {
  return {
    v: 1,
    id,
    kind: 'feature',
    title: 'Rename the widget',
    description: '',
    ask: { text: 'please rename it', source: 'chat://1' },
    clarifications: [],
    workflow: 'quick',
    phase: 'todo',
    dependsOn: [],
    status: 'todo',
    statusReason: null,
    assignee: null,
    repo: null,
    files: [],
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'human',
    updatedAt: '2026-01-02T00:00:00.000Z',
    live: quietLive,
    blocked: false,
    blockedReason: null,
    blockedSince: null,
    blockedBy: [],
  };
}

export function taskSummary(id = 'F1'): TaskSummary {
  const { description: _description, ask, clarifications: _clarifications, ...rest } = taskView(id);
  return { ...rest, descriptionChars: 0, askChars: ask.text.length, askSource: ask.source, clarificationCount: 0 };
}
