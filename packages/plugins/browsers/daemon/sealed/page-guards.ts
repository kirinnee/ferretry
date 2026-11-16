/**
 * WHICH PAGES HOLD A SEALED VALUE (docs/secure-copy.md, "Pages that hold a value").
 *
 * Secure copy seals a value so an agent never reads it. Masking only recognises the value as it was written, so a page
 * that holds one (the origin it was copied from, or pasted into) stays closed to everything that could show it for as
 * long as the value LIVES: `browser.read`, `eval`, `console`, `network`, `screenshot`, `pdf`, `highlight`, `download` and a
 * `wait_for` on text (an oracle for the text). Clicking, typing and navigating still work, but a page that holds a value
 * answers nothing of its own words (see gate.ts). A person's own calls pass.
 *
 * THE SCOPE IS THE BROWSER, NOT THE FERRET. The machine has ONE agent browser: its profile (cookies, storage) and its
 * clipboard are shared by every ferret that uses it, so a page that shows one ferret's sealed value shows it to the
 * next ferret's tools too. A live copy therefore covers its pages for EVERY agent that uses the browser (the registry
 * keeps who sealed it only to name a copy to its own ferret, and to let go of a ferret's copies when its session ends).
 *
 * Accounts tells this registry (through `BrowsersCopyApi.sealed`): a copy now exists, for these origins, and a function
 * that answers when it ends (or nothing once it has). The registry never holds, names to anyone else, or returns a value:
 * only the copy's NAME, the sites it is on and when it ends. Pages are matched by what they show NOW (the host the page
 * is on, and the host of every frame in it), never by the name the agent gave them.
 */

/** The tools a page that holds a sealed value refuses an agent: everything that could show what the page says. */
export const SEALED_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  'browser.read',
  'browser.eval',
  'browser.console',
  'browser.network',
  'browser.screenshot',
  'browser.pdf',
  'browser.highlight',
  'browser.download',
  'browser.wait_for',
]);

/**
 * The tools refused on ANY page whose text shows a live copy, wherever it is: a picture cannot be masked, and a script can
 * return the text in a form the mask does not recognise (encoded, split, reversed).
 */
export const SHOWING_TOOLS: ReadonlySet<string> = new Set([
  'browser.screenshot',
  'browser.pdf',
  'browser.highlight',
  'browser.eval',
]);

interface Held {
  readonly ferret: string;
  readonly copy: string;
  readonly from: readonly string[];
  readonly hosts: ReadonlySet<string>;
  /** When the copy ends, or nothing once it has: asked each time, so a discarded copy lifts its pages at once. */
  readonly until: () => number | undefined;
  /** Covers every page, not only those on `hosts`: an unconfirmed clipboard whose source is not known. */
  readonly everywhere?: true;
}

/** One live copy that covers a page, for a sentence: its name, where it was, when it ends, and whether the caller's own. */
export interface SealedCover {
  readonly copy: string;
  readonly from: readonly string[];
  /** `Infinity` while the browser's clipboard still may hold the value: it ends when the clipboard is emptied. */
  readonly until: number;
  /** Whether it is the asking ferret's own copy: another ferret's is not named (a name is that ferret's own). */
  readonly own: boolean;
}

/** Where a page is: one host, several (the page and every frame in it), or nothing when it cannot be read. */
export type PageHosts = string | undefined | readonly (string | undefined)[];

/** The host (`host[:port]`, lower case) of an origin or an address, or nothing when it names none. */
export function hostOfOrigin(origin: string): string | undefined {
  try {
    const host = new URL(origin).host.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * A clipboard the worker could not empty after a capture: BROWSER state of its own (the clipboard is the browser's, shared
 * by every ferret). It is not a copy: no session ending, no capture or replacement of a copy of the same name and no copy's
 * end touches it. It ends only when a retry CONFIRMS the clipboard empty (a browser that is gone has nothing left to clear).
 */
interface KeptClipboard {
  readonly ferret: string;
  /** What a refusal calls it. */
  readonly copy: string;
  readonly from: readonly string[];
  readonly hosts: ReadonlySet<string>;
  readonly retry: () => Promise<boolean>;
}

/** Told when a value begins to be sealed, so an agent's open picture stream can end at once. */
export type SealedListener = () => void;

/** The daemon's own timer (the kernel clock): the daemon side arms no global timer of its own. Returns what cancels it. */
export interface SealedTimers {
  after(milliseconds: number, action: () => void): () => void;
}

export class SealedPages {
  private readonly held: Held[] = [];
  private readonly pending = new Map<string, number>();
  private scripts = 0;
  private drained: (() => void)[] = [];
  private kept: KeptClipboard | undefined;
  /** Counts every seal that begins (a copy held, a paste protected, a clipboard kept): output made before one may not leave after it. */
  private sealGeneration = 0;
  private readonly listeners = new Set<SealedListener>();

  /** `timers`: how a capture waits for a running script. Without them it does not wait: a running script is a no. */
  constructor(private readonly timers?: SealedTimers) {}

  /**
   * A copy of `ferret`'s now lives, on pages of these origins, until `until()` stops answering. Told again for the same copy
   * (a paste into another page), its origins are added to the ones it already sits on, so a copy pasted a hundred times is one
   * record, and a copy that ended (or was discarded and made again under its name) starts afresh.
   */
  hold(ferret: string, copy: string, origins: readonly string[], until: () => number | undefined): void {
    const index = this.held.findIndex(
      each => each.ferret === ferret && each.copy === copy && each.until() !== undefined,
    );
    const before = index < 0 ? undefined : this.held[index];
    const from = [...new Set([...(before?.from ?? []), ...origins])];
    const hosts = new Set(from.map(hostOfOrigin).filter((host): host is string => host !== undefined));
    const next: Held = { ferret, copy, from, hosts, until };
    if (index < 0) this.held.push(next);
    else this.held[index] = next;
    this.began();
  }

  /** How many seals have begun: output stamped before a change is not delivered after it ({@link SealedGate.mayDeliver}). */
  get generation(): number {
    return this.sealGeneration;
  }

  /** Called synchronously whenever a seal begins. Returns what stops listening. */
  onSeal(listener: SealedListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private began(): void {
    this.sealGeneration += 1;
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch {
        // A listener that fails must not stop the seal or the others being told.
      }
  }

  /** Every copy of `ferret`'s is let go of (its session ended). */
  drop(ferret: string): void {
    for (let at = this.held.length - 1; at >= 0; at -= 1) if (this.held[at]?.ferret === ferret) this.held.splice(at, 1);
    this.pending.delete(ferret);
  }

  /**
   * A clipboard capture is running for this ferret: until the returned function is called, `browser.eval` is refused
   * on every page of the browser, so nothing a script runs can see what the page just put on the clipboard.
   */
  capturing(ferret: string): () => void {
    this.pending.set(ferret, (this.pending.get(ferret) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.pending.get(ferret) ?? 1) - 1;
      if (left <= 0) this.pending.delete(ferret);
      else this.pending.set(ferret, left);
    };
  }

  /** Whether a clipboard capture is running, anyone's: the browser and its clipboard are one for every ferret. */
  isCapturing(_ferret?: string): boolean {
    return this.pending.size > 0;
  }

  /** A script is about to run on a page: until the returned function is called, a capture waits for it ({@link idle}). */
  scriptRunning(): () => void {
    this.scripts += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.scripts -= 1;
      if (this.scripts <= 0) {
        this.scripts = 0;
        for (const resolve of this.drained.splice(0)) resolve();
      }
    };
  }

  /**
   * Resolves `true` once no script runs on any page of the browser, or `false` after `ms`. A capture waits on this after
   * it set {@link capturing}: a script that was already running when the capture began cannot be refused any more, so it
   * is waited for, and none begins in the meantime.
   */
  async idle(ms: number): Promise<boolean> {
    if (this.scripts === 0) return true;
    const timers = this.timers;
    if (timers === undefined) return false;
    return await new Promise<boolean>(resolve => {
      const cancel = timers.after(ms, () => {
        this.drained = this.drained.filter(each => each !== done);
        resolve(false);
      });
      const done = () => {
        cancel();
        resolve(true);
      };
      this.drained.push(done);
    });
  }

  /**
   * The browser's clipboard could not be emptied after a capture, so it may still hold the value. Until a retry confirms it
   * is empty, the capture's pages stay closed whatever becomes of the copy, and a keyboard paste is refused everywhere.
   */
  keepClipboard(ferret: string, copy: string, origins: readonly string[], retry: () => Promise<boolean>): void {
    // Kept state of its own, never a copy's entry: a copy named like it, a session ending or a copy ending leave it alone. A
    // second unconfirmed capture adds its origins to the first's (the same clipboard may still hold either value).
    const from = [...new Set([...(this.kept?.from ?? []), ...origins])];
    const hosts = new Set(from.map(hostOfOrigin).filter((host): host is string => host !== undefined));
    this.kept = { ferret, copy, from, hosts, retry };
    this.began();
  }

  /** Whether the browser's clipboard may still hold a captured value. */
  clipboardKept(): boolean {
    return this.kept !== undefined;
  }

  /** Tries again to empty a clipboard that could not be emptied; a confirmed clear ends the hold. `true` when it is clear. */
  async retryClipboard(): Promise<boolean> {
    const kept = this.kept;
    if (kept === undefined) return true;
    const cleared = await kept.retry().catch(() => false);
    if (cleared && this.kept === kept) this.kept = undefined;
    return this.kept === undefined;
  }

  /** Whether any copy lives, anyone's: a picture of a page is then checked for its text. */
  anyLive(_ferret?: string): boolean {
    return this.live().length > 0;
  }

  /** Every live copy, with whether it is the asking ferret's own: for naming what a page's text shows. */
  copies(ferret: string): readonly { readonly copy: string; readonly own: boolean }[] {
    return this.live().map(({ held }) => ({ copy: held.copy, own: held.ferret === ferret }));
  }

  /**
   * The live copies that cover a page showing these hosts (its own and every frame's). A page whose host cannot be read, or
   * one of whose frames cannot, is covered by every live copy that has a page (it fails closed); a copy with no page (a
   * command's) covers none. `ferret` is the one asking, to tell its own copies from another's.
   */
  covering(ferret: string, hosts: PageHosts): readonly SealedCover[] {
    const shown = hosts === undefined || typeof hosts === 'string' ? [hosts] : hosts;
    const unreadable = shown.some(host => host === undefined);
    const known = new Set(shown.filter((host): host is string => host !== undefined).map(host => host.toLowerCase()));
    return this.live()
      .filter(
        entry =>
          entry.held.everywhere === true ||
          (entry.held.hosts.size > 0 && (unreadable || [...known].some(host => entry.held.hosts.has(host)))),
      )
      .map(({ held, until }) => ({ copy: held.copy, from: held.from, until, own: held.ferret === ferret }));
  }

  private live(): readonly { readonly held: Held; readonly until: number }[] {
    const alive: { readonly held: Held; readonly until: number }[] = [];
    for (let at = this.held.length - 1; at >= 0; at -= 1) {
      const held = this.held[at];
      if (held === undefined) continue;
      const until = held.until();
      if (until === undefined) this.held.splice(at, 1);
      else alive.push({ held, until });
    }
    const kept = this.kept;
    if (kept !== undefined)
      alive.push({
        held: {
          ferret: kept.ferret,
          copy: kept.copy,
          from: kept.from,
          hosts: kept.hosts,
          until: () => Number.POSITIVE_INFINITY,
          // A capture whose page is not known may have left the value for any page: all of them stay closed.
          ...(kept.hosts.size === 0 ? { everywhere: true as const } : {}),
        },
        until: Number.POSITIVE_INFINITY,
      });
    return alive;
  }
}

/** When a closed page opens again, in words. */
function endsWords(until: number, instant: (epoch: number) => string, plural: boolean): string {
  return Number.isFinite(until)
    ? `until ${instant(until)} (when ${plural ? 'the last copy' : 'that copy'} ends)`
    : "until the browser's clipboard has been emptied (Ferretry could not empty it after your capture and tries again on each call)";
}

/** The sentence an agent is told when a page holds a sealed value: why, until when, what still works, how to end it. */
export function sealedPageRefusal(
  tool: string,
  reference: string,
  covers: readonly SealedCover[],
  instant: (epoch: number) => string,
): string {
  const own = covers.filter(cover => cover.own);
  const others = covers.length - own.length;
  const names = [
    ...own.map(cover => `sealed:${cover.copy}`),
    ...(others === 0
      ? []
      : [others === 1 ? 'a value another ferret sealed' : `${String(others)} values other ferrets sealed`]),
  ].join(', ');
  const until = endsWords(Math.max(...covers.map(cover => cover.until)), instant, covers.length !== 1);
  const where = [...new Set(own.flatMap(cover => cover.from))];
  const site = where.length === 0 ? 'this page' : where.join(', ');
  const end =
    own.length === 0
      ? 'It opens when the ferret that sealed it discards it or it ends.'
      : `To use the page sooner, discard ${own.length === 1 ? 'the copy' : 'the copies'} with secure_discard.`;
  return `${tool} is refused on ${reference}: ${site} holds ${names}, a value sealed in this browser, and a read, script or picture of it could show the value. It is closed ${until}; you can still click, type and navigate by structure (an id, a class, a role). ${end} A person's own view is not affected.`;
}

/** The sentence when a clipboard capture is running and a script is asked for. */
export function capturePendingRefusal(tool: string): string {
  return `${tool} is refused while a clipboard capture is running in this browser: a page script could read what the page copied. Try again in a moment.`;
}

/** The sentence when a page's text shows a live sealed value and a picture or a script is asked for. */
export function pictureWithheld(tool: string, reference: string, names: readonly string[], others = 0): string {
  const shown = [
    ...names.map(name => `sealed:${name}`),
    ...(others === 0
      ? []
      : [others === 1 ? 'a value another ferret sealed' : `${String(others)} values other ferrets sealed`]),
  ].join(', ');
  return tool === 'browser.eval'
    ? `${tool} is withheld on ${reference}: the page shows ${shown}, a value sealed in this browser, and a script could return it in a form the mask does not recognise (encoded or split). Read the page as text (it comes back masked) instead.`
    : `${tool} is withheld on ${reference}: the page shows ${shown}, a value sealed in this browser, and a picture cannot be masked. Read it as text (it comes back masked) or ask the owner to look.`;
}
