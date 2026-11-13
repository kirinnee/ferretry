/**
 * WHICH PAGES HOLD A SEALED VALUE (docs/secure-copy.md, "Pages that hold a value").
 *
 * Secure copy seals a value so an agent never reads it. Masking only recognises the value as it was written, so a page
 * that holds one (the origin it was copied from, or pasted into) stays closed to everything that could show it for as
 * long as the value LIVES: `browser.read`, `eval`, `console`, `network`, `screenshot`, `pdf`, `highlight`, `download` and a
 * `wait_for` on text (an oracle for the text). Clicking, typing and navigating still work. A person's own calls pass.
 *
 * Accounts tells this registry (through `BrowsersCopyApi.sealed`): a copy now exists, for these origins, and a function
 * that answers when it ends (or nothing once it has). The registry never holds, names or returns a value: only the copy's
 * NAME, the sites it is on and when it ends. Pages are matched by what they show NOW (the host the page is on), never by
 * the name the agent gave them, so renaming or reopening a page does not lift it.
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
}

/** One live copy that covers a page, for a sentence: its name, where it was, and when it ends. */
export interface SealedCover {
  readonly copy: string;
  readonly from: readonly string[];
  readonly until: number;
}

/** The host (`host[:port]`, lower case) of an origin or an address, or nothing when it names none. */
export function hostOfOrigin(origin: string): string | undefined {
  try {
    const host = new URL(origin).host.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

export class SealedPages {
  private readonly held: Held[] = [];
  private readonly pending = new Map<string, number>();

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
  }

  /** Every copy of `ferret`'s is let go of (its session ended). */
  drop(ferret: string): void {
    for (let at = this.held.length - 1; at >= 0; at -= 1) if (this.held[at]?.ferret === ferret) this.held.splice(at, 1);
    this.pending.delete(ferret);
  }

  /**
   * A clipboard capture is running for this ferret: until the returned function is called, `browser.eval` is refused
   * on every page it has, so nothing it runs can see what the page just put on the clipboard.
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

  isCapturing(ferret: string): boolean {
    return (this.pending.get(ferret) ?? 0) > 0;
  }

  /** Whether any copy of this ferret's lives, a command's included: a picture of a page is then checked for its text. */
  anyLive(ferret: string): boolean {
    return this.live(ferret).length > 0;
  }

  /**
   * The live copies that cover a page of this ferret's showing `host`. A page whose host cannot be read is covered by
   * every live copy that has a page (it fails closed); a copy with no page (a command's) covers none.
   */
  covering(ferret: string, host: string | undefined): readonly SealedCover[] {
    return this.live(ferret)
      .filter(entry => entry.held.hosts.size > 0 && (host === undefined || entry.held.hosts.has(host.toLowerCase())))
      .map(({ held, until }) => ({ copy: held.copy, from: held.from, until }));
  }

  private live(ferret: string): readonly { readonly held: Held; readonly until: number }[] {
    const alive: { readonly held: Held; readonly until: number }[] = [];
    for (let at = this.held.length - 1; at >= 0; at -= 1) {
      const held = this.held[at];
      if (held === undefined) continue;
      const until = held.until();
      if (until === undefined) this.held.splice(at, 1);
      else if (held.ferret === ferret) alive.push({ held, until });
    }
    return alive;
  }
}

/** The sentence an agent is told when a page holds a sealed value: why, until when, what still works, how to end it. */
export function sealedPageRefusal(
  tool: string,
  reference: string,
  covers: readonly SealedCover[],
  instant: (epoch: number) => string,
): string {
  const names = covers.map(cover => `sealed:${cover.copy}`).join(', ');
  const until = instant(Math.max(...covers.map(cover => cover.until)));
  const where = [...new Set(covers.flatMap(cover => cover.from))];
  const site = where.length === 0 ? 'this site' : where.join(', ');
  return `${tool} is refused on ${reference}: ${site} holds ${names}, a value you sealed, and a read, script or picture of it could show the value. It is closed until ${until} (when ${covers.length === 1 ? 'that copy' : 'the last copy'} ends); you can still click, type and navigate. To use the page sooner, discard ${covers.length === 1 ? 'the copy' : 'the copies'} with secure_discard. A person's own view is not affected.`;
}

/** The sentence when a clipboard capture is running and a script is asked for. */
export function capturePendingRefusal(tool: string): string {
  return `${tool} is refused while a clipboard capture of yours is running: a page script could read what the page copied. Try again in a moment.`;
}

/** The sentence when a page's text shows a live sealed value and a picture or a script is asked for. */
export function pictureWithheld(tool: string, reference: string, names: readonly string[]): string {
  const shown = names.map(name => `sealed:${name}`).join(', ');
  return tool === 'browser.eval'
    ? `${tool} is withheld on ${reference}: the page shows ${shown}, a value you sealed, and a script could return it in a form the mask does not recognise (encoded or split). Read the page as text (it comes back masked) instead.`
    : `${tool} is withheld on ${reference}: the page shows ${shown}, a value you sealed, and a picture cannot be masked. Read it as text (it comes back masked) or ask the owner to look.`;
}
