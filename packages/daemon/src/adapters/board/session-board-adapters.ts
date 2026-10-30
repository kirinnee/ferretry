import {
  BOARD_EVENT_TYPES,
  type BoardChangedEvent,
  type BoardSkip,
  BoardSkipSchema,
  type TaskRef,
  TaskRefSchema,
} from '@ferretry/protocol';
import type { BoardChangeSink, SessionFocus, SessionParents } from '../../lib/board/index.ts';
import { jsonObject } from '../../lib/json.ts';
import type { SubFerretDirectory } from '../../lib/sub-ferret/index.ts';
import { withAutoTitle } from '../../lib/names/auto-title.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

type SessionDocuments = Pick<DaemonStorage, 'findSession' | 'readConfig' | 'updateConfig' | 'append'>;

/** The id of a session this daemon holds, or `undefined` for anything else. */
const known = (storage: SessionDocuments, sessionId: string) => {
  const id = tryParseSessionId(sessionId);
  return id === undefined || storage.findSession(id) === undefined ? undefined : id;
};

/** A session's lineage, one step at a time: `config.parent`. An unknown session has no parent. */
export class StorageSessionParents implements SessionParents {
  constructor(private readonly storage: SessionDocuments) {}

  async parentOf(sessionId: string): Promise<string | undefined> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return undefined;
    const parent = jsonObject(await this.storage.readConfig(id))?.parent;
    return typeof parent === 'string' && parent !== '' ? parent : undefined;
  }
}

/**
 * The card a session works on, as `config.focusTask` in its own configuration document — the session
 * owns the fact (`board-design.md` §2.1) — and why it has none, as `config.boardSkip`. Written by spreading
 * the document, so every other field stays; taking a card drops the skip, which was about the work before it.
 */
export class StorageSessionFocus implements SessionFocus {
  constructor(private readonly storage: SessionDocuments) {}

  async setFocus(
    sessionId: string,
    task: TaskRef,
    title?: string,
    options: { readonly anchor?: boolean } = {},
  ): Promise<boolean> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return false;
    const focusTask = TaskRefSchema.parse(task);
    await this.storage.updateConfig(id, current => {
      const { boardSkip: _cleared, ...rest } = jsonObject(current) ?? {};
      return {
        ...(title === undefined ? rest : withAutoTitle(rest, 'card', title)),
        focusTask,
        ...(options.anchor === true ? { focusAnchor: focusTask } : {}),
      };
    });
    return true;
  }

  async focusOf(sessionId: string): Promise<TaskRef | null> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return null;
    const parsed = TaskRefSchema.safeParse(jsonObject(await this.storage.readConfig(id))?.focusTask);
    return parsed.success ? parsed.data : null;
  }

  async anchorOf(sessionId: string): Promise<TaskRef | null> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return null;
    const parsed = TaskRefSchema.safeParse(jsonObject(await this.storage.readConfig(id))?.focusAnchor);
    return parsed.success ? parsed.data : null;
  }

  async skip(sessionId: string, skip: BoardSkip): Promise<boolean> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return false;
    const boardSkip = BoardSkipSchema.parse(skip);
    await this.storage.updateConfig(id, current => ({ ...(jsonObject(current) ?? {}), boardSkip }));
    return true;
  }

  async skipOf(sessionId: string): Promise<BoardSkip | null> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return null;
    const parsed = BoardSkipSchema.safeParse(jsonObject(await this.storage.readConfig(id))?.boardSkip);
    return parsed.success ? parsed.data : null;
  }
}

/**
 * `board.changed` on the fleet feed: one journal entry on the WRITER's session, the way the agenda's
 * `attention.changed` is one on the session whose agenda moved. A feed event always belongs to a
 * session, so a write by the owner or the daemon is journalled on the card's owner ferret (the service
 * picks the session). A session this daemon does not hold has no journal, and the change is not sent.
 */
export class JournalBoardChanges implements BoardChangeSink {
  constructor(private readonly storage: SessionDocuments) {}

  async changed(sessionId: string, event: BoardChangedEvent): Promise<void> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return;
    await this.storage.append(id, BOARD_EVENT_TYPES.changed, event);
  }
}

/** The journal entry the turn-end check leaves, with the mutating work it saw: the audit of each nudge. */
export const BOARD_CHECKED_EVENT = 'board.unfiled-work';

/** Journals a turn-end nudge on the nudged session (`board-design.md` §3.4). */
export class JournalBoardChecks {
  constructor(private readonly storage: SessionDocuments) {}

  async record(sessionId: string, seen: readonly string[]): Promise<void> {
    const id = known(this.storage, sessionId);
    if (id !== undefined) await this.storage.append(id, BOARD_CHECKED_EVENT, { seen: [...seen] });
  }
}

/** The sub-ferret limits' lineage fact, read from the session's own configuration: `parent` is the lead. */
export class StorageSubFerretDirectory implements SubFerretDirectory {
  constructor(private readonly storage: SessionDocuments) {}

  async leadOf(sessionId: string): Promise<string | undefined> {
    return await new StorageSessionParents(this.storage).parentOf(sessionId);
  }

  async addressOf(sessionId: string): Promise<string> {
    const id = known(this.storage, sessionId);
    if (id === undefined) return sessionId;
    const teammate = jsonObject(await this.storage.readConfig(id))?.teammate;
    return typeof teammate === 'string' && teammate !== '' ? teammate : sessionId;
  }
}
