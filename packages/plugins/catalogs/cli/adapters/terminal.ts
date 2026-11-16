import type { CliContext, TerminalIo } from '@ferretry/kernel/manifest';
import type { ICatalogFileWriter, ICatalogOutput, ICatalogPrompt } from '../lib/catalog/ports.ts';
import type { ICatalogFileReader, ICatalogInstallOutput } from '../lib/catalog-install/ports.ts';
import type { IShareScreen, ITerminalSize } from '../lib/catalog-share/ports.ts';
import { FileCatalogWriter } from './export-file.ts';

/**
 * What the shell may hand a CLI half, read by shape: a file writer (`exists`, `write` with `wx` / rename-over) for
 * an export to an arbitrary `--out` path (`ownState` reaches own declared defs only), the size of a file without
 * reading it, and the terminal's width. A shell that hands no writer gets this half's own {@link FileCatalogWriter}
 * (v4's), the way Browsers writes a screenshot; a verb that needs a file reader the shell did not hand it refuses
 * before anything is sent.
 */
interface CliExtras {
  readonly files?: ICatalogFileWriter & {
    /** A file's size from its directory entry, without reading it (today's `stat` before every read). */
    size?(path: string): Promise<number>;
  };
  columns?(): number | undefined;
}

const extras = (ctx: CliContext<never>): CliExtras => ctx as unknown as CliExtras;

/** The shell's terminal carries no colour; today's `ConsoleIo` tinted `success` and `warn` and wrote both to stdout. */
class TerminalOutput implements ICatalogOutput, ICatalogInstallOutput {
  #exitCode = 0;
  constructor(private readonly io: TerminalIo) {}
  report(message: string): void {
    this.io.out(message);
  }
  success(message: string): void {
    this.io.out(message);
  }
  warn(message: string): void {
    this.io.out(message);
  }
  error(message: string): void {
    this.io.err(message);
  }
  diagnostic(message: string): void {
    this.io.err(message);
  }
  setExitCode(code: number): void {
    this.#exitCode = code;
  }
  get exitCode(): number {
    return this.#exitCode;
  }
}

/** A QR is written verbatim (today's `PlainScreen`). */
class TerminalScreen implements IShareScreen {
  constructor(private readonly io: TerminalIo) {}
  write(text: string): void {
    this.io.out(text);
  }
}

/** A typed answer at the terminal; no terminal to ask at reads as no answer, which no question takes for yes. */
class TerminalPrompt implements ICatalogPrompt {
  constructor(private readonly ask_: CliContext<never>['prompt']) {}
  async ask(message: string): Promise<string> {
    return (await this.ask_?.(message)) ?? '';
  }
}

const NO_READER =
  'this fy cannot read a file for Catalogs yet. Nothing was sent. (The fy shell hands plugins a file reader in a later build.)';
/**
 * Today's `FsCatalogFileReader` over the shell: the size first, from a stat when the shell can give one (so a file
 * past the cap is never read), then a read bounded by `maxBytes`. The shell's reader has no cap of its own, so a
 * shell with no stat reads before it counts.
 */
class ShellCatalogFileReader implements ICatalogFileReader {
  readonly #read: CliContext<never>['readText'];
  readonly #stat: ((path: string) => Promise<number>) | undefined;
  readonly #texts = new Map<string, string>();
  constructor(read: CliContext<never>['readText'], stat?: (path: string) => Promise<number>) {
    this.#read = read;
    this.#stat = stat;
  }
  async size(path: string): Promise<number> {
    if (this.#stat !== undefined) return await this.#stat(path);
    return new TextEncoder().encode(await this.#text(path)).length;
  }
  async read(path: string, maxBytes: number): Promise<string> {
    const text = await this.#text(path);
    if (new TextEncoder().encode(text).length > maxBytes)
      throw new Error(`${path} grew past ${maxBytes} bytes while being read`);
    return text;
  }
  async #text(path: string): Promise<string> {
    const held = this.#texts.get(path);
    if (held !== undefined) return held;
    if (this.#read === undefined) throw new Error(NO_READER);
    const text = await this.#read(path);
    this.#texts.set(path, text);
    return text;
  }
}

export interface CatalogTerminal {
  readonly out: TerminalOutput;
  readonly screen: TerminalScreen;
  readonly prompt: TerminalPrompt;
  /** A person to answer: a terminal, and a shell that can ask at it. */
  readonly interactive: boolean;
  readonly reader: ShellCatalogFileReader;
  readonly writer: ICatalogFileWriter;
  readonly size: ITerminalSize;
}

export function catalogTerminal(ctx: CliContext<never>): CatalogTerminal {
  const more = extras(ctx);
  return {
    out: new TerminalOutput(ctx.io),
    screen: new TerminalScreen(ctx.io),
    prompt: new TerminalPrompt(ctx.prompt?.bind(ctx)),
    interactive: ctx.io.isTty && ctx.prompt !== undefined,
    reader: new ShellCatalogFileReader(ctx.readText?.bind(ctx), more.files?.size?.bind(more.files)),
    writer: more.files ?? new FileCatalogWriter(),
    size: { columns: () => more.columns?.() },
  };
}
