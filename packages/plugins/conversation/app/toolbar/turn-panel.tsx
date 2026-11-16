/**
 * WHOSE TURN IT IS, IN THE FERRET'S TOOLBAR (`panels.turn`, slot `ferret.toolbar`, beside Ferrets' status mark). The turn
 * is Conversation's fact: the whose-turn observer's stored state, read from Claude Code's redacted prompt route through
 * the chat's one reader ({@link readChatPrompt}), never a second source. Ferrets' status draws the lifecycle state only
 * (it has no turn to read), so this panel says the part it cannot: working, your turn, or blocked on a person.
 *
 * Nothing is drawn for a ferret that is stopped or whose state could not be read (the observer's last word is history
 * then), for one the observer has said nothing about, or when the prompt route is not there: a missing reading is never
 * drawn as a turn. A compaction in progress is NOT drawn here: it exists only on the live event frame the chat subscribes
 * to, and this panel adds no second subscriber.
 */

import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { type ChatPrompt, readChatPrompt } from '../chat/chat-prompt.ts';
import { useConversationClient } from '../client.ts';

const WORDS = { working: 'Working', 'your-turn': 'Your turn', 'needs-input': 'Needs you' } as const;

const StateRead = z.looseObject({ state: z.string() });

export function TurnPanel({ subject }: { readonly subject?: string }) {
  const client = useConversationClient();
  const [turn, setTurn] = useState<ChatPrompt['turnState']>(undefined);
  useEffect(() => {
    if (subject === undefined) return;
    let live = true;
    const read = (): void => {
      Promise.all([
        readChatPrompt(client, subject),
        client.call('GET /v1/ferrets/:ferretId', { params: { ferretId: subject } }).then(
          answer => StateRead.safeParse(answer).data?.state,
          () => undefined,
        ),
      ]).then(([prompt, state]) => {
        if (live) setTurn(state === undefined || state === 'stopped' ? undefined : prompt?.turnState);
      });
    };
    setTurn(undefined);
    read();
    const stop = client.subscribe(FerretsChanged, change => {
      if (change.ferret === subject) read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, subject]);
  if (turn === undefined) return null;
  return (
    <span className="text-meta text-muted" data-ferret-turn={turn}>
      {WORDS[turn]}
    </span>
  );
}
