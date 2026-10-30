import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionCardFacts, SessionCardSessions } from '../../lib/board/index.ts';
import { jsonObject } from '../../lib/json.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * The owner's latest message in a session's `channel/inbox.jsonl` (`FileSendChannel`): the last message
 * line with no `from`, which is how that log says a person sent it. A line that does not parse is skipped.
 */
export const latestOwnerMessage = (inbox: string): string | undefined => {
  const lines = inbox.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (line === '') continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = jsonObject(JSON.parse(line)) as Record<string, unknown> | undefined;
    } catch {
      continue;
    }
    if (entry?.type !== 'message' || entry.from !== undefined) continue;
    const message = text(entry.message);
    if (message !== undefined) return message;
  }
  return undefined;
};

/**
 * What a session is, for a card made for it after the fact (`fy new` from a lead with no focus card): its
 * name, prompt and parent from its configuration, and the owner's latest message from its inbox log.
 */
export class StorageSessionCardFacts implements SessionCardSessions {
  constructor(
    private readonly storage: Pick<DaemonStorage, 'findSession' | 'readConfig'>,
    private readonly sessionDirectory: (id: SessionId) => string,
  ) {}

  async facts(sessionId: string): Promise<SessionCardFacts | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined || this.storage.findSession(id) === undefined) return undefined;
    const config = jsonObject(await this.storage.readConfig(id)) ?? {};
    const inbox = await readFile(join(this.sessionDirectory(id), 'channel', 'inbox.jsonl'), 'utf8').catch(
      () => undefined,
    );
    return {
      name: text(config.name),
      prompt: text(config.prompt),
      parent: text(config.parent),
      latestOwnerMessage: inbox === undefined ? undefined : latestOwnerMessage(inbox),
    };
  }
}
