import { hostOfOrigin, SEALED_REFUSED_TOOLS, SHOWING_TOOLS, type PageHosts, type SealedPages } from './page-guards.ts';
import { capturePendingRefusal, pictureWithheld, sealedPageRefusal, type SealedCover } from './page-guards.ts';

/**
 * THE ONE PLACE A SEALED PAGE IS GUARDED (docs/secure-copy.md, "Pages that hold a value").
 *
 * Every path an AGENT has to a page's words or pixels asks this gate: the browser tools (inside the page's queue), the
 * Browsers HTTP action route, and the viewer socket's frames. A person's own calls are never asked. The gate throws
 * {@link SealedRefusal}, a sentence that names no value; each transport turns it into its own refusal.
 */

/** A refusal: a sentence an agent may be told. It carries no page words and no value. */
export class SealedRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedRefusal';
  }
}

/** What the gate may ask of the page it guards, from inside that page's queue (the browser's `BrowserGuardPage`). */
export interface SealedPageProbe {
  host?(): Promise<string | undefined>;
  /** The host of the page and of every frame in it (`undefined` when any cannot be read). */
  hosts?(): Promise<readonly (string | undefined)[] | undefined>;
  /** What a read of the page and of every frame in it could show; `undefined` when any part cannot be read. */
  text?(): Promise<string | undefined>;
}

export interface SealedGatePorts {
  readonly sealed: SealedPages;
  /** The text with every live sealed value replaced by `[sealed:name]`, as a read would be; throws when it cannot be. */
  readonly mask: (text: string) => Promise<string>;
}

/** What one call asks of the gate. */
export interface SealedCheck {
  /** The ferret asking, to name its own copies to it and not another's. */
  readonly ferret: string;
  readonly tool: string;
  /** How the agent knows the page (`%browser:app`), for the sentence. */
  readonly reference: string;
  /** The address the page had when it was looked up, for a check made before the page's queue. */
  readonly address?: string | undefined;
  /** The live page, from inside its queue. Absent before the queue. */
  readonly page?: SealedPageProbe | undefined;
  /** Every selector the call names. */
  readonly selectors?: readonly string[];
  /** Keys the call presses (`Control+V`). */
  readonly keys?: readonly string[];
  /** A wait for a duration, which reads nothing. */
  readonly time?: boolean;
}

const WITHHELD_DIALOG = '[withheld: this page holds a sealed value, so what it says is not shown to you]';
const WITHHELD_TITLE = '[withheld: this page holds a sealed value]';
const WITHHELD_ERROR =
  'The page could not do that. Because it holds a sealed value, Ferretry does not pass on what the browser said about it. Check your selector, or ask the owner to look.';

/** The sentence when an answer was made while no value was sealed and one began before it left: nothing of it is passed on. */
export const SEALED_ANSWER_WITHHELD =
  'This answer is withheld: a value was sealed in this browser while it was being made, and it might show it. Nothing of it is passed on. Try again; a page that holds the value stays closed until it ends.';

export const sealedWithheld = { dialog: WITHHELD_DIALOG, title: WITHHELD_TITLE, error: WITHHELD_ERROR } as const;

/** An address cut to its scheme and host: a path, query or fragment can carry what the page wants to say. */
export function originOnly(address: string): string {
  try {
    const url = new URL(address);
    return url.host === '' ? `${url.protocol}…` : `${url.protocol}//${url.host}/…`;
  } catch {
    return '…';
  }
}

/** What was true of the seals when an output began to be made: see {@link SealedGate.mayDeliver}. */
export interface SealedStamp {
  /** How many seals had begun. */
  readonly generation: number;
  /** Whether any value lived. */
  readonly live: boolean;
}

/** Who an output is for: a ferret's credential (an AGENT) or a proved person. */
export type SealedCaller = 'agent' | 'person';

export class SealedGate {
  constructor(private readonly ports: SealedGatePorts) {}

  /** Taken when an output BEGINS to be made (a frame arrives, a picture is asked for); handed to {@link mayDeliver} where it would leave. */
  stamp(): SealedStamp {
    return { generation: this.ports.sealed.generation, live: this.ports.sealed.anyLive() };
  }

  /**
   * THE ONE SYNCHRONOUS DELIVERY CHECK (docs/secure-copy.md, "Where output is checked"): asked right where an output's bytes would
   * LEAVE (the HTTP answer, a frame sent, a held frame's retry), after every await that made them. A person's output always
   * leaves. An agent's does not if a value began to be sealed since `since` (even one that has ended again: the output may
   * show it), and a PICTURE (a viewer's frame, which cannot be masked) does not while any value lives or lived at `since`.
   * It takes the caller as a value so the viewer-scope check (which agent may watch which page) composes with it.
   */
  mayDeliver(caller: SealedCaller, since: SealedStamp, options: { readonly picture?: boolean } = {}): boolean {
    if (caller === 'person') return true;
    if (this.ports.sealed.generation !== since.generation) return false;
    if (options.picture === true) return !since.live && !this.ports.sealed.anyLive();
    return true;
  }

  /** Called synchronously whenever a seal begins (a stream already open ends at once). Returns what stops listening. */
  onSeal(listener: () => void): () => void {
    return this.ports.sealed.onSeal(listener);
  }

  get registry(): SealedPages {
    return this.ports.sealed;
  }

  /** Whether any copy lives, anyone's: while it does, an agent's viewer stream shows nothing. */
  anyLive(): boolean {
    return this.ports.sealed.anyLive();
  }

  /** The live copies that cover a page showing these hosts. */
  covering(ferret: string, hosts: PageHosts): readonly SealedCover[] {
    return this.ports.sealed.covering(ferret, hosts);
  }

  /** The live copies that cover a page by the address it has. */
  coveringAddress(ferret: string, address: string | undefined): readonly SealedCover[] {
    return this.ports.sealed.covering(ferret, address === undefined ? undefined : hostOfOrigin(address));
  }

  /** Throws a {@link SealedRefusal} when an agent's call may not run on this page now. Passes silently otherwise. */
  async check(input: SealedCheck): Promise<void> {
    const sealed = this.ports.sealed;
    // A capture that is running closes every script of the browser, at admission and again at the page's queue.
    if (input.tool === 'browser.eval' && sealed.isCapturing(input.ferret))
      throw new SealedRefusal(capturePendingRefusal('browser.eval'));
    // A clipboard Ferretry could not empty: try again, and until it is empty no keyboard paste is allowed.
    if (sealed.clipboardKept()) await sealed.retryClipboard();
    if (sealed.clipboardKept() && (input.keys ?? []).some(isPasteChord))
      throw new SealedRefusal(
        "A keyboard paste is refused: the browser's clipboard could not be emptied after a capture, so it may still hold a value you sealed and the paste would put it on a page you can read. Ferretry tries to empty it again on each call; once it has, pasting works again.",
      );
    if (!sealed.anyLive(input.ferret)) return;

    const hosts = await this.hostsOf(input);
    const covers = sealed.covering(input.ferret, hosts);
    const instant = (epoch: number): string => new Date(epoch).toISOString();
    if (covers.length > 0) {
      if (SEALED_REFUSED_TOOLS.has(input.tool) && input.time !== true)
        throw new SealedRefusal(sealedPageRefusal(input.tool, input.reference, covers, instant));
      const content = (input.selectors ?? []).find(contentDependentSelector);
      if (content !== undefined)
        throw new SealedRefusal(
          `${input.tool} is refused on ${input.reference}: it holds a sealed value, and a selector that depends on what the page says (its text, a label, an attribute's value) would tell you whether the page shows it. Name the element by structure instead: an id, a class, a tag, a role without a name, or a ref.`,
        );
    }
    // A picture or a script of ANY page whose text shows a live copy, wherever the page is, only inside its queue.
    if (input.page === undefined || !SHOWING_TOOLS.has(input.tool)) return;
    const text = await input.page.text?.().catch(() => undefined);
    if (text === undefined)
      throw new SealedRefusal(
        `${input.tool} is withheld on ${input.reference}: a value sealed in this browser lives, and Ferretry could not read this page's text (and its frames') to check that the picture or script would not show it. Read the page as text instead.`,
      );
    const names = await this.shown(text, input.ferret);
    if (names === undefined)
      throw new SealedRefusal(
        `${input.tool} is withheld on ${input.reference}: a value sealed in this browser lives, and Ferretry could not check this page's text against it. Try again shortly.`,
      );
    if (names.own.length > 0 || names.others > 0)
      throw new SealedRefusal(pictureWithheld(input.tool, input.reference, names.own, names.others));
  }

  /** Whether what a page's act brought back must be withheld: the page (or a frame of it) is one a live copy covers. */
  async covered(ferret: string, address: string | undefined, page?: SealedPageProbe): Promise<boolean> {
    if (!this.ports.sealed.anyLive(ferret)) return false;
    const hosts = await this.hostsOf({ address, page });
    return this.ports.sealed.covering(ferret, hosts).length > 0;
  }

  /** The names (the asking ferret's own) of the live copies a text shows, and how many of other ferrets'; nothing when it cannot be told. */
  private async shown(
    text: string,
    ferret: string,
  ): Promise<{ readonly own: readonly string[]; readonly others: number } | undefined> {
    try {
      const masked = await this.ports.mask(text);
      const found = [...new Set([...masked.matchAll(/\[sealed:([^\]\s]+)\]/gu)].map(each => each[1] as string))];
      const copies = this.ports.sealed.copies(ferret);
      const own = found.filter(name => copies.some(copy => copy.own && copy.copy === name));
      return { own, others: found.length - own.length };
    } catch {
      return undefined;
    }
  }

  private async hostsOf(input: {
    readonly address?: string | undefined;
    readonly page?: SealedPageProbe | undefined;
  }): Promise<PageHosts> {
    const page = input.page;
    if (page === undefined) return input.address === undefined ? undefined : hostOfOrigin(input.address);
    if (page.hosts !== undefined) return await page.hosts().catch(() => undefined);
    if (page.host !== undefined) return await page.host().catch(() => undefined);
    return input.address === undefined ? undefined : hostOfOrigin(input.address);
  }
}

/** Every selector a call names, wherever it sits in it (`selector`, a drag's end, a form field's). */
export function selectorsOf(call: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || typeof value !== 'object') return;
    for (const [key, each] of Object.entries(value)) {
      if (typeof each === 'string' && /selector/iu.test(key)) found.push(each);
      else walk(each, depth + 1);
    }
  };
  walk(call, 0);
  return found;
}

/** The sentence an agent's viewer stream is closed with while a sealed value lives: a picture cannot be masked. */
export const SEALED_STREAM_REFUSAL =
  "This browser view is closed to agents while a value sealed in this browser lives: a picture of a page cannot be masked. A person's own view is not affected; use the page tools (they mask what they return), or ask the owner to look.";

/** A keyboard paste: Control or Meta + V, or Shift + Insert, however the chord is spelled. */
export function isPasteChord(chord: string): boolean {
  const parts = chord
    .split('+')
    .map(part => part.trim().toLowerCase())
    .filter(part => part !== '');
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (
    key === 'v' &&
    modifiers.some(each => ['control', 'ctrl', 'meta', 'cmd', 'command', 'controlormeta'].includes(each))
  )
    return true;
  return key === 'insert' && modifiers.includes('shift');
}

/** Attributes whose value is structure, never page content: matching on one tells nothing about what the page says. */
const STRUCTURAL_ATTRIBUTES = new Set([
  'type',
  'name',
  'id',
  'class',
  'role',
  'for',
  'data-testid',
  'data-test',
  'data-test-id',
  'data-cy',
  'data-qa',
  'lang',
  'dir',
  'disabled',
  'readonly',
  'required',
  'checked',
  'tabindex',
]);
/** The options a `role=` selector takes that say nothing of the page's words (its accessible `name` is not among them). */
const STRUCTURAL_ROLE_OPTIONS = new Set([
  'checked',
  'disabled',
  'expanded',
  'level',
  'pressed',
  'selected',
  'include-hidden',
]);

/**
 * THE SAFE STRUCTURAL SUBSET of selectors, parsed, never guessed. A selector is allowed on a page that holds a sealed value ONLY
 * when every part of it is proved to be one of the forms below; anything else (any syntax this file does not know, whether
 * Playwright's, CSS's or XPath's) is refused. A page that holds a value must not answer a question about what it says (whether a
 * selector found anything, or what it clicked), because a binary search over the answers reads the value one character at a time.
 *
 * ALLOWED, per part of a `>>` chain:
 *   CSS    tags, `*`, `#id`, `.class`, `[attr]` and `[attr op value]` for the structural attributes above only, the structural
 *          pseudo-classes (`:first-child`, `:nth-child(2n+1)`, `:nth-of-type(…)`, `:only-child`, `:enabled`, `:disabled`,
 *          `:checked`, `:visible`) and the combinators (space, `>`, `+`, `~`, `,`); optionally behind `css=`.
 *   id=…   data-testid=… data-test=… data-test-id=… data-cy=… data-qa=…   (a bare value)
 *   nth=N  visible=true|false
 *   role=<role> with options from a short structural list (never `name`)
 *   xpath  element names, `*`, `.`, `..`, `/`, `//`, a position `[3]` or `[last()]`: no attribute test, no function, no string.
 */
function structuralSelector(selector: string): boolean {
  const parts = selector.split('>>');
  return parts.length > 0 && parts.every(part => structuralPart(part.trim()));
}

/** Whether a selector's result may depend on WHAT THE PAGE SAYS, as far as Ferretry can prove: it is not a proven structural one. */
export function contentDependentSelector(selector: string): boolean {
  return !structuralSelector(selector);
}

const IDENT = String.raw`[A-Za-z_][A-Za-z0-9_-]*`;
const BARE_VALUE = String.raw`[A-Za-z0-9_.:/-]+`;
const ATTRIBUTE_VALUE = String.raw`(?:"[^"\\]*"|'[^'\\]*'|[A-Za-z0-9_.:/-]+)`;
const NTH = String.raw`(?:even|odd|[+-]?\d*n(?:\s*[+-]\s*\d+)?|[+-]?\d+)`;
const PSEUDO = new RegExp(
  String.raw`^:(?:first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|enabled|disabled|checked|visible|nth-child\(\s*${NTH}\s*\)|nth-last-child\(\s*${NTH}\s*\)|nth-of-type\(\s*${NTH}\s*\)|nth-last-of-type\(\s*${NTH}\s*\))(?![A-Za-z0-9_-])`,
  'u',
);
const ATTRIBUTE = new RegExp(
  String.raw`^\[\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:([~|^$*]?=)\s*${ATTRIBUTE_VALUE}(?:\s+[is])?\s*)?\]`,
  'u',
);
const STEP = new RegExp(String.raw`^(?:\*|${IDENT})`, 'u');

function structuralPart(text: string): boolean {
  if (text === '') return false;
  if (/^id=/iu.test(text) || /^data-(?:testid|test|test-id|cy|qa)=/iu.test(text))
    return new RegExp(String.raw`^[A-Za-z-]+=${BARE_VALUE}$`, 'u').test(text);
  if (/^nth=/iu.test(text)) return /^nth=-?\d+$/iu.test(text);
  if (/^visible=/iu.test(text)) return /^visible=(?:true|false)$/iu.test(text);
  if (/^role=/iu.test(text)) return structuralRole(text);
  if (/^xpath=/iu.test(text)) return structuralXpath(text.replace(/^xpath=/iu, '').trim());
  if (text.startsWith('/') || text.startsWith('..') || text.startsWith('./')) return structuralXpath(text);
  if (/^css=/iu.test(text)) return structuralCss(text.replace(/^css=/iu, '').trim());
  return structuralCss(text);
}

function structuralRole(text: string): boolean {
  const match = /^role=([A-Za-z]+)((?:\[[^\]]*\])*)$/u.exec(text);
  if (match === null) return false;
  const options = (match[2] as string).match(/\[[^\]]*\]/gu) ?? [];
  return options.every(option => {
    const inner = /^\[\s*([A-Za-z-]+)\s*(?:=\s*(true|false|\d+)\s*)?\]$/u.exec(option);
    return inner !== null && STRUCTURAL_ROLE_OPTIONS.has((inner[1] as string).toLowerCase());
  });
}

/** How many characters of `text` ONE compound selector (`tag#id.class[attr]:pseudo`) takes, 0 when it is none Ferretry can prove structural. */
function compoundLength(text: string): number {
  let rest = text;
  let progressed = false;
  const tag = STEP.exec(rest);
  if (tag !== null) {
    rest = rest.slice(tag[0].length);
    progressed = true;
  }
  for (;;) {
    const named = new RegExp(String.raw`^[#.]${IDENT}`, 'u').exec(rest);
    if (named !== null) {
      rest = rest.slice(named[0].length);
      progressed = true;
      continue;
    }
    const attribute = ATTRIBUTE.exec(rest);
    if (attribute !== null) {
      // Only an attribute whose value is structure: matching another one would ask the page what it says.
      if (!STRUCTURAL_ATTRIBUTES.has((attribute[1] as string).toLowerCase())) return 0;
      rest = rest.slice(attribute[0].length);
      progressed = true;
      continue;
    }
    const pseudo = PSEUDO.exec(rest);
    if (pseudo !== null) {
      rest = rest.slice(pseudo[0].length);
      progressed = true;
      continue;
    }
    break;
  }
  return progressed ? text.length - rest.length : 0;
}

/** CSS made only of tags, ids, classes, structural attributes, structural pseudo-classes and combinators. */
function structuralCss(css: string): boolean {
  let rest = css.trim();
  let needCompound = true;
  while (rest.length > 0) {
    if (needCompound) {
      const used = compoundLength(rest);
      if (used === 0) return false;
      rest = rest.slice(used);
      needCompound = false;
    } else {
      const combinator = /^(?:\s*[>+~,]\s*|\s+)/u.exec(rest);
      if (combinator === null) return false;
      rest = rest.slice(combinator[0].length);
      needCompound = true;
    }
  }
  return css.trim() !== '' && !needCompound;
}

/** XPath made only of element names, `*`, `.`, `..`, `/`, `//` and positions. */
function structuralXpath(xpath: string): boolean {
  const step = String.raw`(?:\*|${IDENT}|\.\.|\.)(?:\[(?:\d+|last\(\))\])*`;
  return new RegExp(String.raw`^(?:\.?\/\/?|\.\.\/)?${step}(?:\/\/?${step})*$`, 'u').test(xpath);
}
