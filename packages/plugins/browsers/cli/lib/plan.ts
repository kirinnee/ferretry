import type { BrowserProxySetting } from '../../contract/index.ts';
import type { Parsed, VerbShape } from './args.ts';

/**
 * What a verb asks of the daemon, as DATA. A verb's builder reads its words and answers one of these; the dispatcher
 * is the only thing that talks (`dispatcher.ts`), so no verb carries its own transport, output or error handling.
 */
export type Plan =
  /** One browser tool, by its MCP name (`browser_click`) and the input without `tool`; a picture goes to `screenshotTo`. */
  | {
      readonly kind: 'tool';
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly screenshotTo?: string;
      /** Typed text the answer must never repeat, whatever the daemon says. */
      readonly scrub?: readonly string[];
    }
  /** `browser_wait_for`, asked in slices the daemon can hold open until `totalMs` has gone; exits 1 on timeout. */
  | { readonly kind: 'wait'; readonly input: Readonly<Record<string, unknown>>; readonly totalMs: number }
  /** A person takes a page over from the ferret, hands it back, or hands one over. */
  | { readonly kind: 'control'; readonly action: 'takeover' | 'handback' | 'handover'; readonly key: string }
  /** Who drives which pages, what a person holds. */
  | { readonly kind: 'view' }
  /** The per-ferret browser route (`GET|POST /v1/ferrets/:ferretId/browser`): `body` absent is the status read. */
  | {
      readonly kind: 'whole';
      readonly body?: Readonly<Record<string, unknown>>;
      /** What to print: the page a read fetched, or the picture's file; absent, the page it landed on or the status. */
      readonly shows?: 'text' | 'screenshot';
      readonly screenshotTo?: string;
      readonly scrub?: readonly string[];
    }
  /** The sign-in window (`GET|POST /v1/browser/login`): `body` absent is the status read. */
  | { readonly kind: 'login'; readonly body?: Readonly<Record<string, unknown>> }
  /** `POST /v1/browser/proxy/test`: the saved proxy, or this one without saving it. */
  | { readonly kind: 'proxy-test'; readonly proxy?: BrowserProxySetting }
  /** Words printed as they are (the firewall files). Exit 0. */
  | { readonly kind: 'print'; readonly text: string }
  /** A sentence and exit 1: something this build cannot do, said plainly. */
  | { readonly kind: 'refuse'; readonly message: string };

/**
 * Whose browser the verb is about.
 * - `page`: a ferret's pages; as the ferret it runs inside, or as a person with `--ferret <id>`.
 * - `whole`: one ferret's whole browser (`FY_SESSION_ID`, or `--ferret <id>`), through the per-ferret route.
 * - `person`: a person's act on a ferret they name; a ferret cannot do it to itself.
 * - `machine`: the machine's browser (sign-in window, proxy); takes no ferret.
 * - `local`: no daemon at all.
 */
export type Scope = 'page' | 'whole' | 'person' | 'machine' | 'local';

/** What a builder may reach: standard input, once, as the person gave it. */
export interface PlanContext {
  readStdin(): Promise<string>;
}

export interface VerbSpec {
  readonly scope: Scope;
  readonly shape: VerbShape;
  readonly plan: (words: Parsed, context: PlanContext) => Plan | Promise<Plan>;
}
