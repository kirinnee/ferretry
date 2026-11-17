/**
 * WHOSE TURN IT IS, IN THE FERRET'S TOOLBAR (`panels.turn`, slot `ferret.toolbar`, beside Ferrets' status mark). The turn
 * is Conversation's fact, and the chat already reads it: the page above this panel hands over its own current reading
 * ({@link useChatTurn}), which its refresh keeps current on every ferret change (including needs-input <-> your-turn
 * while the lifecycle stays idle) and which only ever shows the latest read. This panel asks the daemon nothing, so it
 * can neither lag the conversation beside it nor draw an older answer that landed late.
 *
 * Nothing is drawn for a ferret that is stopped or starting, one the chat could not read or the observer has said nothing
 * about: a missing reading is never drawn as a turn. A compaction in progress is drawn as "Compacting": it exists only on
 * the live event frame the chat subscribes to, so the page hands it over in the same context ({@link useChatCompacting})
 * and this panel adds no second subscriber. It is drawn only for a ferret the chat has a turn reading of, and a ferret
 * that is stopped has none.
 */

import { useChatCompacting, useChatTurn } from '../chat/chat-turn-context.ts';

const WORDS = { working: 'Working', 'your-turn': 'Your turn', 'needs-input': 'Needs you' } as const;

export function TurnPanel({ subject }: { readonly subject?: string }) {
  const turn = useChatTurn(subject);
  const compacting = useChatCompacting(subject);
  if (turn === undefined) return null;
  if (compacting)
    return (
      <span className="text-meta text-muted" data-ferret-turn={turn} data-ferret-compacting="">
        Compacting
      </span>
    );
  return (
    <span className="text-meta text-muted" data-ferret-turn={turn}>
      {WORDS[turn]}
    </span>
  );
}
