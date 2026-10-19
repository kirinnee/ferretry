import type {
  ConversationAdoptRequest,
  ConversationAdoptResult,
  ConversationImportListing,
  ImportableConversation,
} from '@ferretry/protocol';
import type { IContinuePrompt } from '../../../src/lib/import/controller.ts';
import type { IImportGateway, IImportOutput, ImportSearchQuery } from '../../../src/lib/import/ports.ts';

const INSTANT = '2026-10-10T00:00:00.000Z';
export const NOW_MS = Date.parse(INSTANT);

export function conversation(overrides: Partial<ImportableConversation> = {}): ImportableConversation {
  return {
    id: 'c-1',
    harness: 'claude',
    project: '/work/app',
    preview: 'Fix the login page',
    lastActivityAt: INSTANT,
    turns: 4,
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

export function listing(
  conversations: readonly ImportableConversation[] = [conversation()],
  overrides: Partial<Pick<ConversationImportListing, 'matched' | 'skipped'>> = {},
): ConversationImportListing {
  return {
    conversations: [...conversations],
    matched: overrides.matched ?? conversations.length,
    skipped: overrides.skipped ?? 0,
  };
}

/** Records every call and answers with canned fixtures, like the real daemon would. */
export class RecordingImportGateway implements IImportGateway {
  readonly queries: ImportSearchQuery[] = [];
  readonly adoptRequests: ConversationAdoptRequest[] = [];

  constructor(
    private readonly listingAnswer: ConversationImportListing = listing(),
    private readonly adoptAnswer: ConversationAdoptResult = { adopted: [], refused: [] },
  ) {}

  list(query: ImportSearchQuery = {}): Promise<ConversationImportListing> {
    this.queries.push(query);
    return Promise.resolve(this.listingAnswer);
  }

  adopt(request: ConversationAdoptRequest): Promise<ConversationAdoptResult> {
    this.adoptRequests.push(request);
    return Promise.resolve(this.adoptAnswer);
  }
}

export class CapturingImportOutput implements IImportOutput {
  readonly messages: string[] = [];
  readonly errors: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.messages.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

/** Answers `ask` with the next scripted reply; throws if the script runs out. */
export class ScriptedPrompt implements IContinuePrompt {
  private index = 0;

  constructor(private readonly answers: readonly string[]) {}

  ask(_message: string): Promise<string> {
    const answer = this.answers[this.index];
    this.index += 1;
    if (answer === undefined) throw new Error('no scripted answer left');
    return Promise.resolve(answer);
  }
}
