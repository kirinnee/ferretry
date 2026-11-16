import { MAX_PIN_NOTE_LENGTH, type Pin } from '../../../contract/index.ts';
import type { IPinGateway, PinSnapshot } from './gateway.ts';
import { renderPinChange, renderPinList, shortPinId } from './render.ts';

/** Options every pin verb accepts. */
export interface PinOptions {
  /** Another ferret's board; defaults to the ferret the command runs inside. */
  readonly session?: string;
  /** The daemon's snapshot as JSON instead of the human listing. */
  readonly json?: boolean;
}

/** Shortest id prefix accepted: below this, "unambiguous today" is luck rather than identity. */
const MINIMUM_PREFIX_LENGTH = 4;

/** The note as words, so `pin remember to rebase` needs no quotes. */
function noteText(words: readonly string[]): string {
  const text = words.join(' ').trim();
  if (text.length === 0) throw new Error('nothing to pin — give a note or a link');
  if (text.length > MAX_PIN_NOTE_LENGTH)
    throw new Error(`a pin note may not exceed ${MAX_PIN_NOTE_LENGTH} characters (got ${text.length})`);
  return text;
}

/**
 * What a person typed into a full pin uuid: the printed short id (eight characters) or any prefix of at
 * least four, so `pin rm <id>` accepts what `pin ls` prints. An unknown or ambiguous prefix is said as itself.
 */
function resolvePinId(pins: readonly Pin[], token: string): string {
  const needle = token.trim().toLowerCase();
  if (needle === '') throw new Error('a pin id is required — run `pin ls` to see them');
  const exact = pins.find(pin => pin.id.toLowerCase() === needle);
  if (exact !== undefined) return exact.id;
  if (needle.length < MINIMUM_PREFIX_LENGTH)
    throw new Error(`pin id "${token.trim()}" is too short — give at least ${MINIMUM_PREFIX_LENGTH} characters`);
  const matches = pins.filter(pin => pin.id.toLowerCase().startsWith(needle));
  const [first] = matches;
  if (first === undefined) throw new Error(`no pin matches "${token.trim()}" — run \`pin ls\` to see them`);
  if (matches.length > 1)
    throw new Error(
      `"${token.trim()}" matches ${matches.length} pins (${matches.map(pin => shortPinId(pin.id)).join(', ')}) — give more characters`,
    );
  return first.id;
}

/** `fy pin add | edit | ls | rm`: one ferret's pin board, over Ferrets' pin routes. */
export class PinController {
  constructor(
    private readonly gateway: IPinGateway,
    private readonly out: { success(message: string): void },
    /** The ferret the command runs inside (`FY_SESSION_ID`): the default board. The daemon still decides who may write. */
    private readonly own: string | undefined,
  ) {}

  async list(options: PinOptions): Promise<void> {
    const snapshot = await this.gateway.list(this.#target(options));
    this.#report(snapshot, options, () => renderPinList(snapshot));
  }

  async add(words: readonly string[], options: PinOptions): Promise<void> {
    const text = noteText(words);
    const snapshot = await this.gateway.apply(this.#target(options), { action: 'add', kind: 'note', text });
    this.#report(snapshot, options, () => renderPinChange('pinned', undefined, snapshot));
  }

  async edit(token: string, words: readonly string[], options: PinOptions): Promise<void> {
    const text = noteText(words);
    const ferret = this.#target(options);
    const { pins } = await this.gateway.list(ferret);
    const id = resolvePinId(pins, token);
    const pin = pins.find(candidate => candidate.id === id);
    if (pin !== undefined && pin.kind !== 'note')
      throw new Error(`${shortPinId(id)} is a ${pin.kind} pin — only note pins have editable text`);
    const snapshot = await this.gateway.apply(ferret, { action: 'edit', id, text });
    this.#report(snapshot, options, () => renderPinChange('edited', id, snapshot));
  }

  async remove(token: string, options: PinOptions): Promise<void> {
    const ferret = this.#target(options);
    const id = resolvePinId((await this.gateway.list(ferret)).pins, token);
    const snapshot = await this.gateway.apply(ferret, { action: 'remove', id });
    this.#report(snapshot, options, () => renderPinChange('removed', id, snapshot));
  }

  #target(options: PinOptions): string {
    const explicit = options.session?.trim() ?? '';
    if (explicit !== '') return explicit;
    const own = this.own?.trim() ?? '';
    if (own !== '') return own;
    throw new Error('no session id — run inside a session or pass --session <id>');
  }

  #report(snapshot: PinSnapshot, options: PinOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(snapshot, null, 2) : human());
  }
}
