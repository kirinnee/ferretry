/**
 * WHERE OTHER PLUGINS DRAW INSIDE A TRANSCRIPT ROW (`contract/slots.ts`): the chat says which daemon and ferret it is
 * drawing once, and each row mounts the panels contributed to a Conversation slot with its entry. Outside a chat that
 * provided them (a test, a harness) the slots draw nothing, exactly as a slot no plugin contributed to.
 */
import { PanelSlot } from '@ferretry/app';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  type ConversationRowEntry,
  type ConversationRowProps,
  type ConversationRowToolCall,
  type ConversationSlot,
  ROW_TOOL_TEXT_LIMIT,
} from '../../contract/index.ts';
import { shellCommandOf } from './peer-delivery.ts';
import type { ToolCall, TranscriptEntry } from './transcript-entries.ts';

interface RowSlotPlace {
  readonly daemon: string;
  readonly ferret: string;
}

const RowSlotContext = createContext<RowSlotPlace | null>(null);

export function RowSlotProvider({
  daemon,
  ferret,
  children,
}: {
  readonly daemon: string;
  readonly ferret: string;
  readonly children: ReactNode;
}) {
  const place = useMemo(() => ({ daemon, ferret }), [daemon, ferret]);
  return <RowSlotContext.Provider value={place}>{children}</RowSlotContext.Provider>;
}

/**
 * What a contributing plugin may see of a row: ONLY the fields `ConversationRowEntry` names, and only for a row whose
 * words came from the daemon's reading of this ferret's transcript, which is masked there (a value Vault masks is
 * masked in the text). A `ledger` row is this device's own record of a send that has not landed, or never will (a
 * refused send stays in the outbox): its text is what was typed here, before any daemon masked it, so it is never
 * offered to a slot. A `tool` row also offers its SHELL commands (`rowSlotTools`): the command and the text of its answer,
 * from the same redacted reading, and nothing of any other tool. Nothing else of the row (the send, the ledger record, the
 * peer, the other tools' inputs) leaves this file.
 */
export function rowSlotEntry(entry: TranscriptEntry): ConversationRowEntry | null {
  if (entry.kind === 'ledger') return null;
  const tools = rowSlotTools(entry);
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    ...(entry.at === undefined ? {} : { at: entry.at }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(tools.length === 0 ? {} : { tools }),
  };
}

/** The tools whose input IS a command line; only these are ever offered (never a Write, Edit or Read input). */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'exec_command', 'shell', 'local_shell']);

/** The text a tool result carries, as the transcript reads it: `text`, else a string `content`. Never an image. */
const resultText = (result: NonNullable<ToolCall['result']>): string =>
  result.text ?? (typeof result.content === 'string' ? result.content : '');

/**
 * The shell commands of a `tool` row, for a contributor that reads a ferret's own commands. A send a ferret made (the row
 * stands for a message, not a tool group) offers none; a call with no use, or whose input is no command, is left out; an
 * answer is cut at {@link ROW_TOOL_TEXT_LIMIT} characters.
 */
export function rowSlotTools(entry: TranscriptEntry): readonly ConversationRowToolCall[] {
  if (entry.kind !== 'tool' || entry.sent !== undefined || entry.tools === undefined) return [];
  const offered: ConversationRowToolCall[] = [];
  for (const call of entry.tools) {
    const name = call.use.name;
    if (call.orphanResult === true || name === undefined || !SHELL_TOOLS.has(name.toLowerCase())) continue;
    const command = shellCommandOf(call);
    if (command === undefined) continue;
    offered.push({
      key: call.key,
      name,
      command,
      ...(call.ts === undefined ? {} : { ts: call.ts }),
      ...(call.result === undefined
        ? {}
        : {
            result: {
              text: resultText(call.result).slice(0, ROW_TOOL_TEXT_LIMIT),
              ...(call.result.isError === true ? { isError: true } : {}),
            },
          }),
    });
  }
  return offered;
}

/** Every panel contributed to `slot`, for this row; none for a row that is only on this device. */
export function RowSlot({ slot, entry }: { readonly slot: ConversationSlot; readonly entry: TranscriptEntry }) {
  const place = useContext(RowSlotContext);
  const offered = rowSlotEntry(entry);
  if (place === null || offered === null) return null;
  const props: ConversationRowProps = { entry: offered };
  return <PanelSlot daemon={place.daemon} props={{ ...props }} slot={slot} subject={place.ferret} />;
}
