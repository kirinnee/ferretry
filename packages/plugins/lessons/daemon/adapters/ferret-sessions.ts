import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { FerretId, FerretSummary, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { LessonSessionFacts, LessonSessionsPort, OwnerMessage } from '../lib/lessons.ts';

/** The name the scan's miner ferrets carry: a scan never reads a miner. */
const LESSONS_MINER_LABEL = 'ferretry-lessons';
export const LESSONS_MINER_NAME = 'Lesson Scan';

/** How far back the owner's latest message is looked for. */
const OWNER_MESSAGE_WINDOW = 1_200;

/** One ferret as lessons need it. A lead is a ferret a person drives; a helper runs on its own. */
export function lessonSessionFacts(ferret: FerretSummary): LessonSessionFacts {
  return {
    ferretId: ferret.id,
    cwd: ferret.folder,
    harness: ferret.harness === 'codex' ? 'codex' : 'claude',
    mode: ferret.role === 'lead' ? 'interactive' : 'auto',
    ...(ferret.role === 'helper' ? { teammate: ferret.name } : {}),
    ...(ferret.name === LESSONS_MINER_NAME ? { label: LESSONS_MINER_LABEL } : {}),
    createdAt: ferret.createdAt,
    running: ferret.state !== 'stopped',
    hasTranscript: ferret.harnessConversation !== undefined,
  };
}

/** Ferrets from Ferrets; the owner's message from the ferret's own transcript through Conversation. */
export class FerretLessonSessions implements LessonSessionsPort {
  constructor(
    private readonly ferrets: Pick<FerretsApi, 'get' | 'list'>,
    private readonly conversation: Pick<ConversationApi, 'transcript'>,
  ) {}

  async facts(ferretId: string): Promise<LessonSessionFacts | undefined> {
    const ferret = await this.ferrets.get(ferretId as FerretId);
    return ferret === undefined ? undefined : lessonSessionFacts(ferret);
  }

  async list(): Promise<readonly LessonSessionFacts[]> {
    return (await this.ferrets.list()).map(lessonSessionFacts);
  }

  /** The last thing the owner typed into the ferret, and the turn it was: the number of owner messages so far. */
  async latestOwnerMessage(ferretId: string): Promise<OwnerMessage | undefined> {
    const page = await this.conversation.transcript(ferretId as FerretId, { limit: OWNER_MESSAGE_WINDOW });
    if (!page.ok) return undefined;
    const turns = page.value.messages.filter(message => message.role === 'user');
    const last = turns.at(-1);
    if (last === undefined || last.text.trim() === '' || last.timestamp === undefined) return undefined;
    return { text: last.text, at: last.timestamp, turn: turns.length };
  }
}
