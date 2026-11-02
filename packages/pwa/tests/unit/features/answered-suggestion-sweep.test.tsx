/**
 * The Inbox's sweep of ferrets' rule suggestions (R1, C2): it reads the owner's list for each machine whose Inbox holds a
 * suggestion card and marks the ones the list no longer holds as answered, which takes them out of the owner's Inbox. It
 * hides nothing it cannot prove answered: an open suggestion, a machine that refuses or cannot be reached, a card whose
 * machine is not paired here.
 */

import { describe, expect, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { useAnsweredSuggestionSweep } from '../../../src/features/secure-copy/answered-suggestion-sweep.ts';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { AnsweredSuggestions } from '../../../src/lib/answered-suggestions.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../../../src/lib/daemon-connection.ts';
import type { RuleClient } from '../../../src/lib/sign-in-rules.ts';
import { agendaItem, inboxCard } from '../../support/agenda-inbox.tsx';
import { mount } from '../../support/dom.ts';
import { settle } from '../../support/dom-form.ts';
import { refused } from '../../support/sign-in-rule-client.ts';
import { suggestion } from '../../support/sign-in-rule-fixtures.ts';
import { sessionView } from '../../support/sessions.ts';

const STUDIO = daemonId('studio');
const LAPTOP = daemonId('laptop');
const OPEN = 'srg_0000000000000001';
const ANSWERED = 'srg_0000000000000002';
const ELSEWHERE = 'srg_0000000000000003';

const connections = new Map<string, DaemonConnection>([
  [STUDIO, daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' })],
  [LAPTOP, daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example', deviceId: 'phone-1' })],
]);
const connectionFor = (id: string): DaemonConnection | undefined => connections.get(id);

const card = (id: string, suggested: string | undefined, machine = STUDIO): InboxCard =>
  inboxCard(
    agendaItem(id, {
      kind: 'permission',
      subject: 'A ferret suggests a standing rule for a sign-in on github.com.',
      ...(suggested === undefined ? {} : { signInRuleSuggestion: { suggestion: suggested } }),
    } as Partial<AgendaItem>),
    sessionView('sess-1', { config: { teammate: 'pip', name: 'Deploy' } as never }),
    'Workshop',
    machine,
  );

/** Each machine's owner list, or the error it answers with; every read is recorded. */
const clients = (lists: Readonly<Record<string, readonly string[] | Error>>) => {
  const reads: string[] = [];
  const createClient = async (connection: DaemonConnection): Promise<RuleClient> =>
    ({
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        reads.push(`${connection.daemonId} ${path}`);
        const list = lists[connection.daemonId];
        if (list instanceof Error) throw list;
        return schema.parse({ suggestions: (list ?? []).map(id => suggestion({ id })) });
      },
    }) as unknown as RuleClient;
  return { reads, createClient };
};

function Sweep(props: {
  readonly cards: readonly InboxCard[];
  readonly createClient: (connection: DaemonConnection) => Promise<RuleClient>;
  readonly answered: AnsweredSuggestions;
}) {
  useAnsweredSuggestionSweep(props.cards, connectionFor, props.createClient, props.answered);
  return null;
}

const answeredOf = (answered: AnsweredSuggestions, machine: string, id: string): boolean =>
  answered.has(answered.getSnapshot(), daemonId(machine), id);

describe('the app’s answered set', () => {
  it('tells its listeners once per new answer, and stops telling one that left', () => {
    const answered = new AnsweredSuggestions();
    let told = 0;
    const leave = answered.subscribe(() => {
      told += 1;
    });
    answered.mark(STUDIO, [ANSWERED]);
    answered.mark(STUDIO, [ANSWERED]);
    leave();
    answered.mark(STUDIO, [OPEN]);
    expect(told).toBe(1);
    expect(answeredOf(answered, 'studio', OPEN)).toBe(true);
  });
});

describe('the Inbox’s sweep of answered rule suggestions (C2)', () => {
  it('marks only what the owner’s list no longer holds, per machine', async () => {
    const answered = new AnsweredSuggestions();
    const { reads, createClient } = clients({ studio: [OPEN], laptop: [] });
    const mounted = await mount(
      <Sweep
        answered={answered}
        cards={[card('A1', OPEN), card('A2', ANSWERED), card('A3', ELSEWHERE, LAPTOP), card('A4', undefined)]}
        createClient={createClient}
      />,
    );
    try {
      await settle();
      expect(answeredOf(answered, 'studio', OPEN)).toBe(false);
      expect(answeredOf(answered, 'studio', ANSWERED)).toBe(true);
      expect(answeredOf(answered, 'laptop', ELSEWHERE)).toBe(true);
      // The same id on another machine is another suggestion.
      expect(answeredOf(answered, 'laptop', ANSWERED)).toBe(false);
      expect(reads.toSorted()).toEqual([
        'laptop /v1/sign-in-rules/suggestions',
        'studio /v1/sign-in-rules/suggestions',
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it('hides nothing from a machine that refuses or cannot answer', async () => {
    const answered = new AnsweredSuggestions();
    const { createClient } = clients({
      studio: refused('forbidden', { status: 403 }),
      laptop: refused('the daemon is offline'),
    });
    const mounted = await mount(
      <Sweep
        answered={answered}
        cards={[card('A1', ANSWERED), card('A2', ELSEWHERE, LAPTOP)]}
        createClient={createClient}
      />,
    );
    try {
      await settle();
      expect(answeredOf(answered, 'studio', ANSWERED)).toBe(false);
      expect(answeredOf(answered, 'laptop', ELSEWHERE)).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('asks nothing for cards with no suggestion, or whose machine is not paired here', async () => {
    const answered = new AnsweredSuggestions();
    const { reads, createClient } = clients({});
    const mounted = await mount(
      <Sweep
        answered={answered}
        cards={[card('A1', undefined), card('A2', ANSWERED, daemonId('gone'))]}
        createClient={createClient}
      />,
    );
    try {
      await settle();
      expect(reads).toEqual([]);
      expect(answeredOf(answered, 'gone', ANSWERED)).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('marks nothing once the Inbox has gone, whatever the late answer says', async () => {
    const answered = new AnsweredSuggestions();
    let answer: (() => void) | undefined;
    const createClient = async (): Promise<RuleClient> =>
      ({
        request: async (_path: string, schema: { parse: (value: unknown) => unknown }) => {
          await new Promise<void>(resolve => {
            answer = resolve;
          });
          return schema.parse({ suggestions: [] });
        },
      }) as unknown as RuleClient;
    const mounted = await mount(
      <Sweep answered={answered} cards={[card('A1', ANSWERED)]} createClient={createClient} />,
    );
    await settle();
    await mounted.unmount();
    answer?.();
    await settle();
    expect(answeredOf(answered, 'studio', ANSWERED)).toBe(false);
  });
});
