import type { ConversationAdoptResult, Harness, ImportableConversation } from '@ferretry/protocol';
import {
  adoptionBatches,
  CONVERSATION_IMPORT_WINDOW_DAYS,
  CONVERSATION_LAUNCH_MAX,
  conversationsToImport,
  parseImportWindow,
} from '@ferretry/protocol';
import type { IImportGateway, IImportOutput } from './ports.ts';
import { renderAdoptResult, renderImportListing, renderKeepResult, renderSearchMatches } from './render.ts';

/** `<n>d`, `<n>h` or `<n>w` — the only duration grammar `--since` accepts, in either command. */
const SINCE_PATTERN = /^(\d+)(d|h|w)$/u;
const SINCE_UNIT_MS: Record<'d' | 'h' | 'w', number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** Parses `--since`'s duration grammar into milliseconds. Throws a plain `Error` on anything else. */
export function parseSinceDuration(value: string): number {
  const match = SINCE_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error(`--since takes <n>d, <n>h or <n>w (e.g. 7d), not ${JSON.stringify(value)}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as 'd' | 'h' | 'w';
  return amount * SINCE_UNIT_MS[unit];
}

/** `--since` is a duration on this command line, but an ISO instant on the wire; this is the bridge. */
export function sinceInstant(value: string, now: () => number): string {
  return new Date(now() - parseSinceDuration(value)).toISOString();
}

/** Resolves the one harness a `--select` adoption request may carry. */
function inferHarness(rows: readonly ImportableConversation[]): Harness {
  const harnesses = new Set(rows.map(row => row.harness));
  if (harnesses.size > 1) {
    throw new Error('selected conversations span more than one harness; pass --harness to pick one');
  }
  // Both callers adopt only a non-empty selection, so there is always exactly one harness here.
  return [...harnesses][0] as Harness;
}

/** Collaborators and facts shared by both commands in this domain. */
export interface ImportContext {
  readonly now: () => number;
  readonly binaryName: string;
}

export interface ImportListOptions {
  readonly query?: string;
  readonly harness?: Harness;
  /** A duration (`7d`), converted to the wire's ISO instant at request time. */
  readonly since?: string;
  readonly json?: boolean;
}

export interface ImportSelectOptions {
  readonly select: readonly string[];
  readonly runtime?: string;
  readonly harness?: Harness;
  readonly start?: boolean;
  readonly json?: boolean;
}

export interface ImportKeepOptions {
  /** `true` keeps everything; otherwise `since` names the window. */
  readonly all?: boolean;
  /** One of the offered windows (`1d`, `3d`, `7d`, `14d`, `30d`). */
  readonly since?: string;
  readonly runtime?: string;
  readonly harness?: Harness;
  readonly json?: boolean;
}

/** The daemon's own cap on one query (`ConversationImportQuerySchema.limit`); resolving `--select` wants the lot. */
const SELECT_RESOLUTION_LIMIT = 5_000;

/** `fy import conversations`: list existing CLI conversations, or adopt named ones as ferrets. */
export class ImportController {
  constructor(
    private readonly gateway: IImportGateway,
    private readonly out: IImportOutput,
    private readonly context: ImportContext,
  ) {}

  async list(options: ImportListOptions): Promise<void> {
    const listing = await this.gateway.list({
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.query === undefined || options.query === '' ? {} : { q: options.query }),
      ...(options.since === undefined ? {} : { since: sinceInstant(options.since, this.context.now) }),
    });
    this.out.success(
      options.json === true ? JSON.stringify(listing, null, 2) : renderImportListing(listing, this.context.binaryName),
    );
  }

  /** `--all` / `--since <window>`: keep every conversation in the window as a stopped ferret, hard-linked, in batches. */
  async keep(options: ImportKeepOptions): Promise<void> {
    const runtime = options.runtime?.trim();
    if (runtime === undefined || runtime === '') throw new Error('--runtime is required to import conversations');
    const days = options.all === true ? undefined : parseImportWindow(options.since ?? '');
    if (options.all !== true && days === undefined) {
      throw new Error(
        `--since takes one of ${CONVERSATION_IMPORT_WINDOW_DAYS.map(day => `${day}d`).join(', ')} when importing`,
      );
    }
    const listing = await this.gateway.list({
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      limit: SELECT_RESOLUTION_LIMIT,
    });
    const ids = conversationsToImport(listing.conversations, days, this.context.now());
    const byId = new Map(listing.conversations.map(row => [row.id, row] as const));
    const adopted: ConversationAdoptResult['adopted'] = [];
    const refused: ConversationAdoptResult['refused'] = [];
    if (ids.length > 0) {
      const harness = options.harness ?? inferHarness(ids.map(id => byId.get(id) as ImportableConversation));
      for (const batch of adoptionBatches(ids)) {
        const result = await this.gateway.adopt({
          harness,
          runtime,
          conversations: batch.map(id => ({ id, start: false })),
        });
        adopted.push(...result.adopted);
        refused.push(...result.refused);
      }
    }
    const payload = { adopted, refused };
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : renderKeepResult(payload));
    if (refused.length > 0) this.out.setExitCode(1);
  }

  async select(options: ImportSelectOptions): Promise<void> {
    if (options.select.length === 0) throw new Error('--select needs at least one conversation id');
    const runtime = options.runtime?.trim();
    if (runtime === undefined || runtime === '') throw new Error('--runtime is required with --select');
    if (options.start === true && new Set(options.select).size > CONVERSATION_LAUNCH_MAX) {
      throw new Error(
        `at most ${CONVERSATION_LAUNCH_MAX} conversations may start at once; run again without --start to keep the rest stopped`,
      );
    }

    const listing = await this.gateway.list({
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      limit: SELECT_RESOLUTION_LIMIT,
    });
    const byId = new Map(listing.conversations.map(row => [row.id, row] as const));
    const ids = [...new Set(options.select)];
    const known = ids.filter(id => byId.has(id));
    const unknown = ids.filter(id => !byId.has(id));

    const refused: ConversationAdoptResult['refused'] = unknown.map(id => ({
      id,
      code: 'not_found',
      reason: 'not found in the listing on this machine',
    }));
    let adopted: ConversationAdoptResult['adopted'] = [];

    if (known.length > 0) {
      const harness = options.harness ?? inferHarness(known.map(id => byId.get(id) as ImportableConversation));
      const result = await this.gateway.adopt({
        harness,
        runtime,
        conversations: known.map(id => ({ id, start: options.start === true })),
      });
      adopted = result.adopted;
      refused.push(...result.refused);
    }

    const payload = { adopted, refused };
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : renderAdoptResult(payload));
    if (refused.length > 0) this.out.setExitCode(1);
  }
}

/** The narrowest prompt `fy new --continue` needs — satisfied structurally by the shipped `IPrompt`. */
export interface IContinuePrompt {
  ask(message: string): Promise<string>;
}

export interface ContinueContext extends ImportContext {
  /** Whether a human can actually answer the picker prompt. */
  readonly interactive: boolean;
}

export interface NewSessionOptions {
  /** `fy new` without this says to use `fy start` instead, and refuses. */
  readonly continue?: boolean;
  readonly query?: string;
  readonly harness?: Harness;
  readonly since?: string;
  readonly runtime?: string;
}

/** How many of the newest matches `fy new --continue` searches and offers. */
const CONTINUE_SEARCH_LIMIT = 20;

/** `fy new --continue`: find an existing conversation and pick it back up as a ferret. */
export class ContinueSessionController {
  constructor(
    private readonly gateway: IImportGateway,
    private readonly out: IImportOutput,
    private readonly prompt: IContinuePrompt,
    private readonly context: ContinueContext,
  ) {}

  async run(options: NewSessionOptions): Promise<void> {
    if (options.continue !== true) {
      this.out.error(
        `\`${this.context.binaryName} new\` continues an existing conversation; start a fresh session with \`${this.context.binaryName} start\`.`,
      );
      this.out.setExitCode(1);
      return;
    }

    // Continue lists Ferretry's own history and, while "Keep in sync" is on, the computer's CLI homes.
    const listing = await this.gateway.list({
      source: 'synced',
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.query === undefined || options.query === '' ? {} : { q: options.query }),
      ...(options.since === undefined ? {} : { since: sinceInstant(options.since, this.context.now) }),
      limit: CONTINUE_SEARCH_LIMIT,
    });
    const rows = listing.conversations;

    if (rows.length === 0) {
      this.out.error(
        `no conversations matched; try a different search, or start fresh with \`fy start\`.${
          listing.computerListed === false
            ? ' Conversations on this computer are hidden: turn on Keep in sync in Settings › Machine › Conversations.'
            : ''
        }`,
      );
      this.out.setExitCode(1);
      return;
    }

    const chosen = rows.length === 1 ? rows[0] : await this.pick(rows);
    if (chosen === undefined) return;

    if (chosen.adoptedBy !== undefined) {
      this.out.success(
        `already kept as ${chosen.adoptedBy} — attach with \`${this.context.binaryName} attach ${chosen.adoptedBy}\`` +
          `, or \`${this.context.binaryName} resume ${chosen.adoptedBy}\` first if it is stopped.`,
      );
      return;
    }

    const runtime = await this.resolveRuntime(options.runtime);
    if (runtime === undefined) return;

    const result = await this.gateway.adopt({
      harness: chosen.harness,
      runtime,
      conversations: [{ id: chosen.id, start: true }],
    });

    if (result.refused.length > 0) {
      this.out.error(result.refused.map(item => item.reason).join('; '));
      this.out.setExitCode(1);
      return;
    }

    const adopted = result.adopted[0];
    if (adopted === undefined) throw new Error('the daemon adopted nothing and refused nothing');
    this.out.success(
      `${adopted.name} (${adopted.session}) — attach with \`${this.context.binaryName} attach ${adopted.session}\`.`,
    );
  }

  /** More than one row matched: interactively choose one, or refuse when nobody can answer. */
  private async pick(rows: readonly ImportableConversation[]): Promise<ImportableConversation | undefined> {
    if (!this.context.interactive) {
      this.out.error(
        `${rows.length} conversations matched; narrow the search (a query, --harness, --since), or run this interactively to choose.`,
      );
      this.out.setExitCode(1);
      return undefined;
    }
    this.out.success(renderSearchMatches(rows));
    const answer = (await this.prompt.ask(`Pick 1-${rows.length}:`)).trim();
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > rows.length) {
      throw new Error(`not a listed choice: ${JSON.stringify(answer)}`);
    }
    return rows[index - 1];
  }

  /** `--runtime`, or asked for interactively; refused up front when nobody can answer. */
  private async resolveRuntime(given: string | undefined): Promise<string | undefined> {
    const trimmed = given?.trim();
    if (trimmed !== undefined && trimmed !== '') return trimmed;
    if (!this.context.interactive) {
      this.out.error('--runtime names the runtime this session runs on.');
      this.out.setExitCode(1);
      return undefined;
    }
    const asked = (await this.prompt.ask('Runtime to run it on:')).trim();
    if (asked === '') throw new Error('a runtime name is required');
    return asked;
  }
}
