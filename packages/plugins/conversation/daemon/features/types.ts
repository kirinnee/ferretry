import type { RouteHandler, SocketAccept } from '@ferretry/kernel/contract';
import type {
  DaemonContext,
  DaemonHalf,
  FeatureContribution as KernelContribution,
  ToolHandler,
} from '@ferretry/kernel/manifest';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { HarnessGate, MailboxApi } from '@ferretry/core-mailbox/contract';
import type { ConversationApi, Question } from '../../contract/index.ts';
import type manifest from '../../manifest.ts';
import type { ChannelOutbox } from '../channel/lib/outbox.ts';
import type { SharedDraftService } from '../drafts/lib/index.ts';
import type { ReadingHalf } from '../reading.ts';
import type { ClockPort } from '../seams/ports.ts';
import type { TurnBoundaries, TurnPhase } from '../turns/lib/index.ts';

/**
 * A Conversation FEATURE: one file under `daemon/features/` (`<feature>.feature.ts`), one default export, nothing else
 * to edit. The generator (`scripts/gen/registries.ts`) lists every such file into `daemon/generated/features.ts`, and
 * `build()` in `daemon/index.ts` composes the lot (`./compose.ts`), so a feature that adds a route, a socket, a tool, a
 * hook, a subscriber or a piece of the Conversation port adds ONE file and touches no composition root.
 */
export interface ConversationFeature {
  /** What this feature is called in a wiring fault (a key two features serve, a feature that throws). Unique. */
  readonly id: string;
  /**
   * Builds the feature from the shared context and returns what it serves. A feature assigns what others need to
   * `f.late` and reads what others built only at the moment of use, never while registering.
   */
  readonly register: (f: ConversationContext) => FeatureContribution | undefined;
}

type Half = DaemonHalf<typeof manifest>;
/** The hook implementations the manifest declares Conversation takes (`hooks`), each under its `name:key`. */
export type ConversationHooks = Partial<NonNullable<Half['hooks']>>;
/** The events the manifest declares Conversation hears (`subscribers`). */
export type ConversationSubscribers = Partial<NonNullable<Half['subscribers']>>;

/**
 * What one feature serves. The kernel kit's three sections (routes, sockets, port members: two features serving one key
 * is a wiring fault) plus what Conversation's half also carries: agent tools, hook implementations, event subscribers and
 * what a stop must do. `hooks` is a function so a hook that reads what ANOTHER feature built is made only after every
 * feature has registered (the daemon builds the whole half in one go; nothing runs in between).
 */
export interface FeatureContribution extends KernelContribution<ConversationApi> {
  readonly tools?: Readonly<Record<string, ToolHandler>>;
  readonly hooks?: () => ConversationHooks;
  readonly subscribers?: ConversationSubscribers;
  /**
   * Route keys (`guard: 'secrets'`) that already build their answer inside their own redaction read, or serve bytes no
   * mask may touch. Every other such route is wrapped in `maskedBody` by the composition.
   */
  readonly scrubsItsOwnBody?: readonly string[];
  /** Fields a masked route serves as they are stored, beyond bytes and digests, by route key. */
  readonly verbatimFields?: Readonly<Record<string, readonly string[]>>;
  /** Run when the daemon stops, in the order the features registered. */
  readonly stop?: () => void;
}

/**
 * Values a feature needs from one that registers beside it. The feature that owns a value assigns it when it registers;
 * every reader reads it at the moment of use (inside a handler, a hook thunk or a timer), never while registering.
 */
interface LateBindings {
  /** Part b: the reader, links, attachments, renders and search (the `reading` feature). */
  reading?: ReadingHalf;
  /** The shared draft (the `drafts` feature): a send takes what it carried out of it. */
  drafts?: SharedDraftService;
  /** The turn boundaries (the `turns` feature): a stop marks the round it ended, a ferret change is one look. */
  boundaries?: TurnBoundaries;
  /** `question.json`: the question a ferret is waiting on, as the question watch stored it (the `questions` feature). */
  askedQuestion?: (ferret: string) => Promise<Question | undefined>;
  /** The Claude channel's outbox (the `channel` feature). */
  channelOutbox?: ChannelOutbox;
  /** What a ferret change does to the turn boundaries and to the channel (the `turns` feature). */
  turns?: { look(ferret: string, phase: TurnPhase): void; forget(ferret: string): void };
  /** The question watch: one look at a ferret, and the withdrawal of the question a stopped ferret was asking. */
  questions?: { look(ferret: string): void; withdraw(ferret: string): Promise<void> };
  /** The agenda's cards for a ferret parked on a prompt: its pane is read on the next sweep, and one sweep of all (the `prompts` feature). */
  prompts?: { changed(ferret: string): void; sweep(): Promise<void> };
}

/** The shared context every feature registers against: what the kernel handed `build`, built once, in one place. */
export interface ConversationContext {
  /** The context the kernel handed Conversation's `build`. */
  readonly daemon: DaemonContext<typeof manifest>;
  readonly kernel: DaemonContext<typeof manifest>['kernel'];
  readonly ferrets: DaemonContext<typeof manifest>['needs']['ferrets'];
  /** The Agenda's board, as far as Conversation reaches it (the kernel hands the whole port). */
  readonly asks: Pick<AsksApi, 'get' | 'raise' | 'open' | 'close'> & Partial<Pick<AsksApi, 'snapshots'>>;
  readonly hooks: DaemonContext<typeof manifest>['hooks'];
  /** The Mailbox's port: the queue lives there. */
  readonly mailbox: MailboxApi;
  /** Which of the harness seam's two actions are live. */
  readonly gate: HarnessGate;
  /** The kernel's clock, as the ported send, queue, question and turn code reads it. */
  readonly clock: ClockPort;
  readonly late: LateBindings;
}

/** A value another feature assigns to `late`, read at the moment of use: refused loudly when nobody assigned it. */
export function built<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`conversation: the ${name} was read before any feature built it`);
  return value;
}

/** What the composition hands `build`: every feature's sections, merged. */
export interface ComposedConversation {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  readonly port: Partial<ConversationApi>;
  readonly tools: Readonly<Record<string, ToolHandler>>;
  readonly hooks: ConversationHooks;
  readonly subscribers: ConversationSubscribers;
  readonly scrubsItsOwnBody: ReadonlySet<string>;
  readonly verbatimFields: Readonly<Record<string, readonly string[]>>;
  readonly stop: () => void;
}
