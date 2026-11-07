import type { CliContext, TerminalIo } from '@ferretry/kernel/manifest';
import type { ICatalogFileWriter, ICatalogOutput, ICatalogPrompt } from '../lib/catalog/ports.ts';
import type { ICatalogFileReader, ICatalogInstallOutput } from '../lib/catalog-install/ports.ts';
import type { IShareScreen, ITerminalSize } from '../lib/catalog-share/ports.ts';

/**
 * TODO(CliContext port): DECISIONS-1 #21 gives a CLI half prompt/confirm, and rebuild/port-kernel adds `prompt?` and
 * `readText?` to `CliContext` (optional until the fy shell fills them in). rebuild/5.0's `CliContext` has neither yet,
 * and no CliContext has a file WRITER, so this half reads them by shape and refuses, before anything is sent, a verb
 * that needs one the shell did not hand it. No `fs` here: a CLI half reaches files only through the shell.
 */
interface CliExtras {
  readText?(path: string): Promise<string>;
  prompt?(question: string): Promise<string | undefined>;
  /** Not on any CliContext yet: today's `FileCatalogWriter` (`exists`, `write` with `wx` / rename-over). */
  readonly files?: ICatalogFileWriter;
  /** Not on any CliContext yet: the terminal's width, or nothing when it will not say. */
  columns?(): number | undefined;
}

const extras = (ctx: CliContext<never>): CliExtras => ctx as unknown as CliExtras;

/** The shell's terminal carries no colour; today's `ConsoleIo` tinted `success` and `warn` and wrote both to stdout. */
export class TerminalOutput implements ICatalogOutput, ICatalogInstallOutput {
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
export class TerminalScreen implements IShareScreen {
  constructor(private readonly io: TerminalIo) {}
  write(text: string): void {
    this.io.out(text);
  }
}

/** A typed answer at the terminal; no terminal to ask at reads as no answer, which no question takes for yes. */
export class TerminalPrompt implements ICatalogPrompt {
  constructor(private readonly ask_: CliExtras['prompt']) {}
  async ask(message: string): Promise<string> {
    return (await this.ask_?.(message)) ?? '';
  }
}

const NO_READER =
  'this fy cannot read a file for Catalogs yet. Nothing was sent. (The fy shell hands plugins a file reader in a later build.)';
const NO_WRITER =
  'this fy cannot write a file for Catalogs yet, so nothing was signed. (The fy shell hands plugins a file writer in a later build.)';

/** Today's `FsCatalogFileReader` over the shell's reader: its size first, then a read bounded by `maxBytes`. */
export class ShellCatalogFileReader implements ICatalogFileReader {
  readonly #read: CliExtras['readText'];
  readonly #texts = new Map<string, string>();
  constructor(read: CliExtras['readText']) {
    this.#read = read;
  }
  async size(path: string): Promise<number> {
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

/** Refuses up front, before the export is signed, when the shell gave no writer. */
const refusingWriter: ICatalogFileWriter = {
  exists: async () => {
    throw new Error(NO_WRITER);
  },
  write: async () => {
    throw new Error(NO_WRITER);
  },
};

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
    prompt: new TerminalPrompt(more.prompt?.bind(ctx)),
    interactive: ctx.io.isTty && more.prompt !== undefined,
    reader: new ShellCatalogFileReader(more.readText?.bind(ctx)),
    writer: more.files ?? refusingWriter,
    size: { columns: () => more.columns?.() },
  };
}
