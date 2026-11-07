import { MAX_PIN_NOTE_LENGTH, type PinSnapshot } from '@ferretry/protocol';
import { assertEditablePin, resolvePinId } from './pin-id.ts';
import type { IPinGateway, IPinOutput } from './ports.ts';
import { renderPinList, renderPinMutation } from './render.ts';

/** Options every pin command accepts. */
export interface PinCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol snapshot verbatim instead of the human listing. */
  readonly json?: boolean;
}

/** Note text arrives as commander's variadic words so `pin add remember to rebase` needs no quotes. */
function noteText(words: readonly string[]): string {
  const text = words.join(' ').trim();
  if (text.length === 0) throw new Error('nothing to pin — give a note or a link');
  if (text.length > MAX_PIN_NOTE_LENGTH) {
    throw new Error(`a pin note may not exceed ${MAX_PIN_NOTE_LENGTH} characters (got ${text.length})`);
  }
  return text;
}

/**
 * Drives `fy pin …`: resolves the target session, asks the daemon, and renders the answer.
 *
 * Like `fy signal`, every verb defaults to the session the command runs inside, so the common agent
 * case needs no id; `--session` targets another board for a human managing the fleet. The daemon
 * still refuses a cross-session write from an agent — this default is a convenience, not authority.
 */
export class PinController {
  constructor(
    private readonly gateway: IPinGateway,
    private readonly out: IPinOutput,
    private readonly ownSessionId: string | undefined,
  ) {}

  async list(options: PinCommandOptions): Promise<void> {
    const snapshot = await this.gateway.list(this.#target(options));
    this.#report(snapshot, options, () => renderPinList(snapshot));
  }

  async add(words: readonly string[], options: PinCommandOptions): Promise<void> {
    const text = noteText(words);
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'add', kind: 'note', text });
    this.#report(snapshot, options, () => renderPinMutation('pinned', undefined, snapshot));
  }

  async edit(token: string, words: readonly string[], options: PinCommandOptions): Promise<void> {
    const text = noteText(words);
    const sessionId = this.#target(options);
    const board = await this.gateway.list(sessionId);
    const id = resolvePinId(board.pins, token);
    assertEditablePin(board.pins, id);
    const snapshot = await this.gateway.apply(sessionId, { action: 'edit', id, text });
    this.#report(snapshot, options, () => renderPinMutation('edited', id, snapshot));
  }

  async remove(token: string, options: PinCommandOptions): Promise<void> {
    const sessionId = this.#target(options);
    const board = await this.gateway.list(sessionId);
    const id = resolvePinId(board.pins, token);
    const snapshot = await this.gateway.apply(sessionId, { action: 'remove', id });
    this.#report(snapshot, options, () => renderPinMutation('removed', id, snapshot));
  }

  /** Which session this invocation acts on. */
  #target(options: PinCommandOptions): string {
    const explicit = options.session?.trim() ?? '';
    if (explicit !== '') return explicit;
    const own = this.ownSessionId?.trim() ?? '';
    if (own !== '') return own;
    throw new Error('no session id — run inside a session or pass --session <id>');
  }

  #report(snapshot: PinSnapshot, options: PinCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(snapshot, null, 2) : human());
  }
}
