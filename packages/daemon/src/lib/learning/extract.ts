export interface NormalizedRecordLike {
  readonly type?: string;
  readonly timestamp?: string;
  readonly source?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface InboxSendLike {
  readonly text: string;
  /** Present when the send came from a teammate rather than a human. */
  readonly from?: string;
  readonly fromName?: string;
  readonly at?: string;
}

export interface RawSessionInput {
  readonly sessionId: string;
  readonly teammate?: string;
  readonly mode: 'interactive' | 'auto';
  readonly cwd: string;
  readonly repo: string;
  readonly harness: string;
  readonly status: string;
  readonly finishedAt?: string;
  readonly records: readonly NormalizedRecordLike[];
  readonly turnTexts: readonly string[];
  readonly inbox: readonly InboxSendLike[];
  readonly interrupts: number;
}

export interface SessionDigest {
  readonly sessionId: string;
  readonly teammate?: string;
  readonly mode: 'interactive' | 'auto';
  readonly cwd: string;
  readonly repo: string;
  readonly harness: string;
  readonly at: string;
  readonly hasSignal: boolean;
  readonly signalReasons: readonly string[];
  readonly corpus: string;
  readonly digest: string;
  readonly humanMessages: number;
  readonly teammateSteers: number;
  readonly interrupts: number;
  readonly toolFailures: number;
}

const DIGEST_CHARACTER_CAP = 8_000;

function recordText(record: NormalizedRecordLike, key: string): string | undefined {
  const value = record.data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extract only user-controlled material from a completed session. Assistant
 * output is deliberately absent from `corpus`, which makes quote verification
 * proof of human-side evidence rather than a miner echoing model prose.
 */
export function extractSession(input: RawSessionInput): SessionDigest {
  const userTexts: string[] = [];
  let toolFailures = 0;
  for (const record of input.records) {
    if (record.type === 'chat.user') {
      const text = recordText(record, 'text');
      if (text !== undefined) userTexts.push(text);
    } else if (record.type === 'tool.result' && record.data?.isError === true) {
      toolFailures += 1;
    }
  }

  const humanInbox = input.inbox.filter(send => send.from === undefined && send.text.trim().length > 0);
  const teammateInbox = input.inbox.filter(send => send.from !== undefined && send.text.trim().length > 0);
  const followupUserMessages = Math.max(0, userTexts.length - 1);
  const humanMessages = input.mode === 'interactive' ? followupUserMessages + humanInbox.length : humanInbox.length;
  const teammateSteers = teammateInbox.length;
  const signalReasons: string[] = [];

  if (input.mode === 'interactive') signalReasons.push('interactive session (human at the wheel)');
  if (followupUserMessages > 0) signalReasons.push(`${followupUserMessages} follow-up user message(s)`);
  if (teammateSteers > 0) signalReasons.push(`${teammateSteers} lead/peer steer(s)`);
  if (humanInbox.length > 0) signalReasons.push(`${humanInbox.length} human send(s)`);
  if (input.interrupts > 0) signalReasons.push(`${input.interrupts} interrupt(s)`);
  if (toolFailures >= 2) signalReasons.push(`${toolFailures} tool failures`);
  if (input.status === 'failed' || input.status === 'stalled') signalReasons.push(`terminal status ${input.status}`);

  const corpus = [...userTexts, ...input.turnTexts, ...input.inbox.map(send => send.text)]
    .filter(text => text.length > 0)
    .join('\n');
  const digestLines = [
    ...input.turnTexts.map((text, index) => `[brief ${index + 1}]\n${text.trim()}`),
    ...input.inbox.map(
      send => `[${send.from === undefined ? 'human' : `steer(${send.fromName ?? send.from})`}] ${send.text.trim()}`,
    ),
    ...userTexts.map(text => `[user] ${text.trim()}`),
  ];
  const renderedDigest = digestLines.join('\n\n');

  return {
    sessionId: input.sessionId,
    teammate: input.teammate,
    mode: input.mode,
    cwd: input.cwd,
    repo: input.repo,
    harness: input.harness,
    at: input.finishedAt ?? input.records.at(-1)?.timestamp ?? '',
    hasSignal: signalReasons.length > 0,
    signalReasons,
    corpus,
    digest:
      renderedDigest.length <= DIGEST_CHARACTER_CAP
        ? renderedDigest
        : `${renderedDigest.slice(0, DIGEST_CHARACTER_CAP)}\n… [truncated]`,
    humanMessages,
    teammateSteers,
    interrupts: input.interrupts,
    toolFailures,
  };
}
