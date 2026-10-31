/**
 * What the spend budgets read and remember on this machine (docs/budgets.md): which sessions ran on what,
 * where their transcripts are — a Claude session's sub-agents included — and which hard limits the owner
 * was already told about.
 */
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { BudgetHold } from '@ferretry/fleet';
import { type SessionConfig, SessionConfigSchema, SessionStateSchema, type SessionStatus } from '@ferretry/protocol';
import { z } from 'zod';
import type { BudgetSession } from '../../lib/budget/service.ts';
import type { MeteredFile, MeteredMove, MeteredSession } from '../../lib/budget/meter.ts';
import { sessionRunning } from '../../lib/fleet/runtime-sessions.ts';
import type { FileSystemPort } from '../../lib/ports.ts';
import type { IndexedSession } from '../../lib/storage-types.ts';
import type { SessionId } from '../../lib/session-id.ts';

/** The slice of session storage the budgets read. */
export interface BudgetStorage {
  listSessions(): readonly IndexedSession[];
  readConfig(id: SessionId): Promise<unknown>;
  readState(id: SessionId): Promise<unknown>;
}

/** What a session's own documents say about it, once: the runtime it runs as changes only by a migration. */
interface SessionFacts {
  readonly metered: MeteredSession;
  readonly name: string;
  /** The transcript its last conversion moved it off, which still holds what it spent before. */
  readonly convertedFrom?: MeteredFile;
}

/**
 * Every move a session made, oldest first: its `migrations` list, or — for a session that predates it — the
 * one `migration` it carries. Every `at` is an instant: the session schema refuses one that is not.
 */
function movesOf(config: Pick<SessionConfig, 'migration' | 'migrations'>): readonly MeteredMove[] {
  const moves = config.migrations ?? (config.migration === undefined ? [] : [config.migration]);
  return moves
    .map(move => ({ from: move.from, atMs: Date.parse(move.at) }))
    .toSorted((left, right) => left.atMs - right.atMs);
}

const isRunning = (status: string | undefined): boolean => {
  const parsed = SessionStateSchema.shape.status.safeParse(status);
  return parsed.success && sessionRunning(parsed.data as SessionStatus);
};

/**
 * The sessions over this daemon's storage. A session's documents are read when it is first seen and again
 * whenever its index entry moved (a migration rewrites its config), so a refresh reads only what changed.
 */
export class StorageBudgetSessions {
  readonly #facts = new Map<
    string,
    { readonly updatedAt: string | undefined; readonly facts: SessionFacts | undefined }
  >();

  constructor(private readonly storage: BudgetStorage) {}

  /** Every session running now or updated since `sinceMs`. */
  async sessions(sinceMs: number): Promise<readonly MeteredSession[]> {
    const recent = this.storage
      .listSessions()
      .filter(session => isRunning(session.status) || Date.parse(session.updatedAt ?? '') >= sinceMs);
    const found = await Promise.all(recent.map(async session => await this.#factsOf(session)));
    return found.flatMap(facts => (facts === undefined ? [] : [facts.metered]));
  }

  /** The transcript a session's last conversion moved it off, when it has one. */
  async convertedFrom(id: string): Promise<MeteredFile | undefined> {
    return this.#facts.get(id)?.facts?.convertedFrom;
  }

  /** The running sessions whose runtime is one of `agents`. */
  async live(agents: ReadonlySet<string>): Promise<readonly BudgetSession[]> {
    const running = this.storage.listSessions().filter(session => isRunning(session.status));
    const found = await Promise.all(running.map(async session => await this.#factsOf(session)));
    return found.flatMap(facts =>
      facts === undefined || facts.metered.agent === null || !agents.has(facts.metered.agent)
        ? []
        : [{ id: facts.metered.id, name: facts.name, agent: facts.metered.agent }],
    );
  }

  /** The session most recently updated whose runtime is one of `agents`. */
  async recent(agents: ReadonlySet<string>): Promise<BudgetSession | undefined> {
    const newest = this.storage
      .listSessions()
      .toSorted((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
    for (const session of newest.slice(0, 200)) {
      const facts = await this.#factsOf(session);
      const agent = facts?.metered.agent;
      if (facts !== undefined && agent !== null && agent !== undefined && agents.has(agent))
        return { id: facts.metered.id, name: facts.name, agent };
    }
    return undefined;
  }

  async #factsOf(session: IndexedSession): Promise<SessionFacts | undefined> {
    const known = this.#facts.get(session.id);
    if (known !== undefined && known.updatedAt === session.updatedAt) return known.facts;
    const config = SessionConfigSchema.safeParse(await this.storage.readConfig(session.id).catch(() => undefined));
    const facts: SessionFacts | undefined = config.success
      ? {
          metered: {
            id: session.id,
            harness: config.data.harness === 'codex' ? 'codex' : 'claude',
            agent: config.data.agent ?? null,
            moves: movesOf(config.data),
          },
          name: config.data.teammate ?? config.data.label ?? session.id,
          ...(config.data.conversion === undefined
            ? {}
            : {
                convertedFrom: {
                  path: config.data.conversion.fromFile,
                  harness: config.data.conversion.fromHarness === 'codex' ? 'codex' : 'claude',
                },
              }),
        }
      : undefined;
    this.#facts.set(session.id, { updatedAt: session.updatedAt, facts });
    return facts;
  }
}

/**
 * A Claude session's sub-agent transcripts. Claude Code writes each sub-agent's conversation beside the
 * session's own, as `<conversation>/subagents/agent-<id>.jsonl` next to `<conversation>.jsonl`; the
 * analytics index does not read them, and a budget must, because they spend on the same login.
 */
export async function claudeSubagentFiles(transcript: string): Promise<readonly string[]> {
  const directory = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  const entries = await readdir(directory).catch(() => [] as string[]);
  return entries
    .filter(name => name.endsWith('.jsonl'))
    .toSorted()
    .map(name => join(directory, name));
}

const HoldsSchema = z.record(
  z.string(),
  z.strictObject({
    period: z.enum(['daily', 'weekly']),
    level: z.enum(['over_trigger', 'over_hard']),
    limitUsd: z.number().finite().positive(),
    resetsAtMs: z.number().finite(),
    timeZone: z.string().min(1),
  }),
);

/**
 * The holds the last daemon published, read SYNCHRONOUSLY at boot: they must be in place before the first
 * publish, which can come before anything asynchronous here has run. A missing or garbled file is none.
 */
export function readBudgetHoldsSync(path: string): Readonly<Record<string, BudgetHold>> {
  try {
    const parsed = HoldsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Keeps the holds just published, for {@link readBudgetHoldsSync} at the next boot. */
export const budgetHoldsWriter =
  (files: Pick<FileSystemPort, 'writeTextAtomic'>, path: string) =>
  async (holds: Readonly<Record<string, BudgetHold>>): Promise<void> => {
    await files.writeTextAtomic(path, `${JSON.stringify(holds, null, 2)}\n`);
  };

const ToldSchema = z.array(z.string());

/** Which hard limits the owner was told about, as one small JSON list in the state home. */
export class FileBudgetTold {
  constructor(
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic'>,
    private readonly path: string,
  ) {}

  async read(): Promise<readonly string[]> {
    const text = await this.files.readText(this.path).catch(() => undefined);
    if (text === undefined) return [];
    try {
      const parsed = ToldSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async write(keys: readonly string[]): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(keys, null, 2)}\n`);
  }
}
