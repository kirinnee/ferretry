import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AccountModel, expandAssetPath } from '@ferretry/fleet';
import type { AnalyticsPricingRate, SessionView } from '@ferretry/protocol';
import { snapshotAnalyticsUsagePricing } from '../../lib/analytics/pricing.ts';
import {
  GLOBAL_LESSONS_COMPONENT,
  GLOBAL_LESSONS_FILE,
  type GlobalLessonsPort,
  type LessonFilesPort,
  type LessonSessionFacts,
  type LessonSessionsPort,
  type OwnerMessage,
  type PassiveChannelPort,
  type PricePort,
} from '../../lib/learning/index.ts';
import type { SessionDirectorySubsystem } from '../../lib/runtime/mounts/sessions.ts';
import type { SessionTranscriptReader } from '../../lib/session/transcript/reader.ts';
import { isOwnerMessage } from '../../lib/transcript/owner.ts';

/**
 * The lessons domain's ports over the daemon's real world: its sessions and their transcripts, the
 * instruction files an Apply writes, the fleet's global lessons component, a ferret's launch
 * environment and its queue, and the price list.
 */

const TERMINAL = new Set(['completed', 'failed', 'stalled', 'stopped']);

/** How far back the owner's latest message is looked for. */
const OWNER_MESSAGE_WINDOW = 1_200;

/** One session as lessons need it. */
export function lessonSessionFacts(session: SessionView): LessonSessionFacts {
  return {
    sessionId: session.config.id,
    cwd: session.config.cwd,
    harness: session.config.harness === 'codex' ? 'codex' : 'claude',
    mode: session.config.mode,
    ...(session.config.teammate === undefined ? {} : { teammate: session.config.teammate }),
    ...(session.config.label === undefined ? {} : { label: session.config.label }),
    createdAt: session.config.createdAt,
    running: !TERMINAL.has(session.state.status),
    hasTranscript: session.config.transcript?.file !== undefined,
  };
}

/** Sessions from the daemon's own directory; the owner's message from the session's own transcript. */
export class DirectoryLessonSessions implements LessonSessionsPort {
  constructor(
    private readonly sessions: SessionDirectorySubsystem,
    private readonly transcripts: SessionTranscriptReader,
  ) {}

  async facts(sessionId: string): Promise<LessonSessionFacts | undefined> {
    const session = await this.sessions.get(sessionId);
    return session === undefined ? undefined : lessonSessionFacts(session);
  }

  async list(): Promise<readonly LessonSessionFacts[]> {
    return (await this.sessions.list()).map(lessonSessionFacts);
  }

  /**
   * The last thing the owner typed into the session, and the turn it was: the number of user turns so
   * far. Read from the transcript the harness wrote, never from anything the ferret sent.
   */
  async latestOwnerMessage(sessionId: string): Promise<OwnerMessage | undefined> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const events = await this.transcripts.tail(
      { sessionId, harness: session.config.harness === 'codex' ? 'codex' : 'claude' },
      OWNER_MESSAGE_WINDOW,
    );
    const turns = events.filter(isOwnerMessage);
    const last = turns.at(-1);
    if (last === undefined || last.text.trim() === '') return undefined;
    return { text: last.text, at: last.timestamp ?? session.config.updatedAt, turn: turns.length };
  }
}

/**
 * Instruction files outside the state home. Written atomically (a sibling temp file, then a rename),
 * so a crash mid-write never leaves an owner's AGENTS.md half written.
 */
export class NodeLessonFiles implements LessonFilesPort {
  async projectRoot(cwd: string): Promise<string> {
    let directory = cwd;
    for (;;) {
      if (await this.exists(join(directory, '.git'))) return directory;
      const parent = dirname(directory);
      if (parent === directory) return cwd;
      directory = parent;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  async write(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${randomUUID()}.fy-lesson`);
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  }

  join(directory: string, name: string): string {
    return join(directory, name);
  }
}

/** The fleet as the global lessons component needs it: what is in effect, and an owner's write. */
export interface FleetConfigAccess {
  readonly assetsDirectory: string;
  /** The person's home, which a component file under `~` or `$HOME` is relative to. */
  readonly userHome: string;
  model(): AccountModel;
  /** Writes `components/instructions/lessons.yaml` when it is not there, acknowledged as the owner's. */
  writeComponent(file: string): Promise<void>;
}

/** The global lessons document, `<assets>/instructions/lessons.md`, behind the `instructions/lessons` component. */
export class FleetGlobalLessons implements GlobalLessonsPort {
  constructor(private readonly fleet: FleetConfigAccess) {}

  async locate(): Promise<{ readonly path: string; readonly notes: readonly string[] }> {
    const model = this.fleet.model();
    const component = model.components.instructions[GLOBAL_LESSONS_COMPONENT];
    const file = component?.file ?? GLOBAL_LESSONS_FILE;
    const path = expandAssetPath(file, this.fleet.userHome, this.fleet.assetsDirectory);
    const reference = `instructions/${GLOBAL_LESSONS_COMPONENT}`;
    const profiles = Object.entries(model.profiles)
      .filter(([, profile]) => profile.layers.includes(reference))
      .map(([name]) => name);
    const notes = [
      ...(component === undefined
        ? [`Applying creates the instructions component "${GLOBAL_LESSONS_COMPONENT}" for this file.`]
        : []),
      profiles.length === 0
        ? `No profile includes ${reference} yet, so no ferret reads it: add it to a profile.`
        : `Read by ferrets on the profile${profiles.length === 1 ? '' : 's'} ${profiles.join(', ')}.`,
    ];
    return { path, notes };
  }

  async ensureComponent(): Promise<void> {
    if (this.fleet.model().components.instructions[GLOBAL_LESSONS_COMPONENT] !== undefined) return;
    await this.fleet.writeComponent(GLOBAL_LESSONS_FILE);
  }
}

/** How a ferret's switch reaches it, from the composition root's session environment and send queue. */
export interface PassiveChannelParts {
  /** Merges variables into the session's launch environment, under that session's own lock. */
  mergeEnvironment(sessionId: string, variables: Readonly<Record<string, string>>): Promise<void>;
  /** A queued, non-interrupting send; answers its id. */
  send(sessionId: string, message: string, sendId: string): Promise<void>;
  readonly variable: string;
}

export class SessionPassiveChannel implements PassiveChannelPort {
  constructor(private readonly parts: PassiveChannelParts) {}

  async setEnvironment(sessionId: string, passive: boolean): Promise<void> {
    await this.parts.mergeEnvironment(sessionId, { [this.parts.variable]: passive ? '1' : '0' });
  }

  async reinstruct(sessionId: string, message: string): Promise<string> {
    const sendId = `learning-${randomUUID()}`;
    await this.parts.send(sessionId, message, sendId);
    return sendId;
  }
}

/** A model's equivalent price for a scan, from the operator's own price list. */
export class CatalogPrices implements PricePort {
  constructor(
    private readonly catalog: () => Promise<readonly AnalyticsPricingRate[]>,
    private readonly now: () => string,
  ) {}

  async usd(model: string, inputTokens: number, outputTokens: number): Promise<number | undefined> {
    const priced = snapshotAnalyticsUsagePricing(
      {
        pricingModel: model,
        createdAt: this.now(),
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningTokens: null,
      },
      await this.catalog().catch(() => []),
    );
    return priced.kind === 'priced' ? priced.equivalentApiCostUsdMicros / 1_000_000 : undefined;
  }
}
