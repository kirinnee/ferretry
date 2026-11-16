import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { BoardSkip, CardRef, FocusFile } from '../../../contract/index.ts';
import { BoardUnavailableError, type FerretFocus } from '../../lib/board/index.ts';
import type { SerialRun } from '../../lib/lanes/serial.ts';
import { FerretIdSchema, type FerretsApi } from '@ferretry/core-ferrets/contract';

type Entry = FocusFile['ferrets'][string];
const EMPTY: Entry = { card: null, anchor: null, skip: null };
const SECTION = 'board:focus';

/**
 * Which card each ferret works on, the card its own delegations go under, and why its work has no card
 * (`state/board/focus.json`). Ferrets keeps none of it, so Board holds it. A ferret that does not exist cannot be
 * focused: `setFocus` and `skip` answer `false`, as today's did for a session that was gone.
 *
 * One file holds every ferret's focus (today kept one per ferret), so a damaged file is never read as "no focus" and a
 * write that did not land is never reported done: each is warned about and refused as an unavailable board.
 */
export class KernelFerretFocus implements FerretFocus {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, FocusFile>,
    private readonly ferrets: Pick<FerretsApi, 'get'>,
    private readonly serial: SerialRun,
    private readonly diagnostics: { warn(message: string): void },
    private readonly titled: (ferret: string, title: string) => Promise<void> = async () => undefined,
  ) {}

  async setFocus(
    ferret: string,
    card: CardRef,
    title?: string,
    options?: { readonly anchor?: boolean },
  ): Promise<boolean> {
    if (!(await this.exists(ferret))) return false;
    await this.change(ferret, entry => ({
      card,
      anchor: options?.anchor === true ? card : entry.anchor,
      skip: null,
    }));
    if (title !== undefined) await this.titled(ferret, title).catch(() => undefined);
    return true;
  }

  async focusOf(ferret: string): Promise<CardRef | null> {
    return (await this.entry(ferret)).card;
  }

  async focusOfAll(): Promise<ReadonlyMap<string, CardRef | null>> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw this.damaged('read', 'every ferret', read.error.sentence);
    return new Map(Object.entries(read.value?.ferrets ?? {}).map(([ferret, entry]) => [ferret, entry.card] as const));
  }

  async anchorOf(ferret: string): Promise<CardRef | null> {
    return (await this.entry(ferret)).anchor;
  }

  async skip(ferret: string, skip: BoardSkip): Promise<boolean> {
    if (!(await this.exists(ferret))) return false;
    await this.change(ferret, entry => ({ ...entry, skip: { reason: skip.reason, at: skip.at } }));
    return true;
  }

  async skipOf(ferret: string): Promise<BoardSkip | null> {
    const skip = (await this.entry(ferret)).skip;
    return skip === null ? null : { reason: skip.reason, at: skip.at };
  }

  private async exists(ferret: string): Promise<boolean> {
    const id = FerretIdSchema.safeParse(ferret);
    return id.success && (await this.ferrets.get(id.data).catch(() => undefined)) !== undefined;
  }

  private async entry(ferret: string): Promise<Entry> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw this.damaged('read', ferret, read.error.sentence);
    return read.value?.ferrets[ferret] ?? EMPTY;
  }

  private damaged(what: 'read' | 'written', ferret: string, sentence: string): BoardUnavailableError {
    const message = `the board's focus file could not be ${what} for ${ferret}: ${sentence}`;
    this.diagnostics.warn(message);
    return new BoardUnavailableError(message);
  }

  private async change(ferret: string, edit: (entry: Entry) => Entry): Promise<void> {
    await this.serial.run(SECTION, async () => {
      const updated = await this.state.update(this.file, current => ({
        format: 1 as const,
        ferrets: { ...(current?.ferrets ?? {}), [ferret]: edit(current?.ferrets[ferret] ?? EMPTY) },
      }));
      if (!updated.ok) throw this.damaged('written', ferret, updated.error.sentence);
    });
  }
}
