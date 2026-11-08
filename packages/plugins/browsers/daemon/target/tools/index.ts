/**
 * THE PAGE TOOLS THAT TYPE INTO A PAGE OR HAND IT TO ITS OWNER (§4.7): `browser_type` (Op `type`), `browser_fill_form`
 * (Op `fill`), `browser_request_input` and `browser_ask_owner` (no Op: they raise a card or hand a page over and act on
 * nothing). Copied from today's `daemon/src/lib/agent-tools/service.ts` (`browse` for type and fill, the
 * `browser.request_input` and `browser.ask_owner` cases, `noteIdentity` / `identityAfter`). A type or a fill answers a
 * strict `Done on %browser:…` (lead decision 4): whether it hit a password field stays inside, for `identityAfter`.
 *
 * What changed is where each check lives. Every act runs through `kernel.act` on the page's hold target (I119, I121), so
 * the Vault's `InputHolds` decides by effect: a pending card with any non-`code` field refuses `type` and `fill` (I118);
 * a code-only card lets `type` through and only `type` (I32). The answer of a write is an `Ack` closed by the kernel:
 * no URL, no title, nothing the page wrote. Resolving the page, the ownership and takeover checks, the driving marker
 * and the hand-over are the agent browser's (`PageToolHost`, bound by the daemon half).
 */
import type { InputRaise, VaultApi } from '@ferretry/core-vault/contract';
import type { CallContext, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import { actOnPage, type HoldAudience, heldOrMasked } from '../../holds/index.ts';
import {
  type BrowserFillFormInput,
  BrowserAskOwnerInputSchema,
  BrowserFillFormInputSchema,
  type BrowserPushApprovalInput,
  BrowserRequestInputSchema,
  type BrowserTypeInput,
  BrowserTypeInputSchema,
} from './schemas.ts';

/** Who calls a page tool, as the daemon half derived it from the call's standing — never from the call's body. */
export interface PageCaller {
  readonly kind: 'agent' | 'person';
  /** The ferret whose pages these are: the calling ferret, or the one a person's route names. */
  readonly ferret: FerretId;
  /** The ferret's display name, for the driving marker and the hand-over. */
  readonly name?: string;
}

/** A page resolved inside the caller's ferret and cleared for this caller. */
export interface ResolvedPage {
  /** The daemon's id of the page (the runtime's): its hold target and the id the input target checks a card against. */
  readonly id: string;
  readonly name?: string;
}

/** One page input act as the agent browser runs it (today's `BrowserPageAction` `type` and `fill-form`). */
export type PageInputAction =
  | {
      readonly action: 'type';
      readonly selector?: string;
      readonly ref?: string;
      readonly text: string;
      readonly submit?: true;
      readonly slowly?: true;
    }
  | { readonly action: 'fill-form'; readonly fields: BrowserFillFormInput['fields'] };

/**
 * What the browser saw an input act do, for the daemon only: never published (the tool answers an `Ack`). The field it
 * typed into was a password field, or an identifier box (an email or username) on this host.
 */
export interface PageInputOutcome {
  readonly passwordField?: true;
  readonly identifierHost?: string;
  readonly identifierFields?: readonly { readonly index: number; readonly host: string }[];
}

/** The agent browser, as these tools need it (Browsers' runtime and its surface control, bound by the daemon half). */
export interface PageToolHost {
  /** Who is calling, from the call's standing; `undefined` refuses the call. */
  caller(call: CallContext): PageCaller | undefined;
  /**
   * The page `key` names among the caller's ferret's pages, cleared for this caller: a ferret acts only on a page it
   * opened or was handed, and never on one a person took over. Rejects with a sentence that names no other ferret's page.
   */
  resolve(caller: PageCaller, key: string): Promise<ResolvedPage>;
  /** One input act in the page's own queue (the takeover check is repeated there). */
  act(caller: PageCaller, page: ResolvedPage, action: PageInputAction): Promise<PageInputOutcome>;
  /** Hands the page to the owner ("Your turn here"). Rejects when the owner could not be told. */
  askOwner(caller: PageCaller, page: ResolvedPage, message: string | undefined): Promise<void>;
  /** The driving marker; a courtesy, so a failure is swallowed. */
  drove?(caller: PageCaller, page: ResolvedPage): Promise<void>;
  /**
   * The page an act touched, as the sign-in lock groups acts: its id, whether it shares storage with others (incognito,
   * a popup's opener) and the hosts it and its popups are on. `undefined`, or no `hosts`, widens the act (I100).
   */
  actedPage?(caller: PageCaller, page: ResolvedPage): Promise<ActedPage | undefined>;
}

/** Who a page signs in, as the ferret typed it (`../sign-in/identities.ts`). */
interface PageIdentities {
  typed(ferret: string, pageId: string, host: string, text: string): void;
  cleared(ferret: string, pageId: string): void;
}

/**
 * A push approval (`push: true`): Accounts owns approvals; Browsers only reads the number a provider's page shows.
 * Absent: the tool says so.
 */
interface PageApprovals {
  raise(caller: PageCaller, page: ResolvedPage, push: BrowserPushApprovalInput): Promise<{ readonly summary: string }>;
}

/** The page an act touched (today's `ActedPage`): hosts by `../../holds/site.ts` grouping on the lock's side. */
export interface ActedPage {
  readonly id: string;
  readonly incognito?: true;
  readonly openerId?: string;
  readonly hosts?: readonly string[];
}

/** One act, told before it runs; `placed` says which page once the call is over (`undefined`: every page). */
interface ActNote {
  placed(page: ActedPage | undefined): void;
}

/** Today's `loginActs`: told each time a ferret drives a page, before the act. `script` is a page script's. */
interface PageActs {
  acted(ferret: FerretId, script: boolean): ActNote | undefined;
}

/** What the page tools are built from. */
export interface PageToolDeps {
  readonly kernel: Pick<KernelPorts, 'act' | 'redaction'>;
  readonly host: PageToolHost;
  /** Input requests are raised through the Vault (it owns the card, its holds and its evidence). */
  readonly vault?: Pick<VaultApi, 'raiseInput'>;
  readonly identities?: PageIdentities;
  readonly approvals?: PageApprovals;
  /** Told of every page act a ferret makes, before it runs (the Vault's sign-in lock, I99 and I100). */
  readonly acts?: PageActs;
}

/** A page tool's refusal or failure, already worded for whoever called. */
class PageToolError extends Error {}

const surfaceReference = (page: ResolvedPage): string => `%browser:${page.name ?? page.id}`;

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** What an input act did to who the page signs in: named someone, or may have changed it unseen. */
type IdentityAfter = 'clear' | { readonly host: string; readonly username: string };

/**
 * WHO THE PAGE IS SIGNING IN after an input act (today's `identityAfter`, I154): kept from the agent's type or fill into
 * ONE identifier box, never beside a password field; cleared by anything else, and by any act of a person.
 */
function identityAfter(action: PageInputAction, outcome: PageInputOutcome, byAgent: boolean): IdentityAfter {
  if (!byAgent || outcome.passwordField === true) return 'clear';
  if (action.action === 'type')
    return outcome.identifierHost === undefined ? 'clear' : { host: outcome.identifierHost, username: action.text };
  const [only, ...more] = outcome.identifierFields ?? [];
  const entry = only === undefined ? undefined : action.fields[only.index];
  const text = entry?.text ?? entry?.value;
  return only === undefined || more.length > 0 || text === undefined ? 'clear' : { host: only.host, username: text };
}

const failed = (text: string): ToolResult => ({ text, isError: true });

/** The input of a call, parsed; a problem answers its first sentence, never the input. */
function parsed<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new PageToolError(result.error.issues[0]?.message ?? 'that call is not one this tool takes');
}

/** The four page tools, keyed by their manifest names. */
export function pageInputTools(deps: PageToolDeps): {
  readonly browser_type: ToolHandler;
  readonly browser_fill_form: ToolHandler;
  readonly browser_request_input: ToolHandler;
  readonly browser_ask_owner: ToolHandler;
} {
  const { host, kernel } = deps;

  const callerOf = (call: CallContext): PageCaller => {
    const caller = host.caller(call);
    if (caller === undefined) throw new PageToolError('Only a ferret, or a person in its session, drives its pages.');
    return caller;
  };

  /** Runs one input act on a page under its hold, and keeps or clears who the page signs in. */
  const input = async (
    call: CallContext,
    key: string,
    op: 'type' | 'fill',
    action: PageInputAction,
  ): Promise<ToolResult> => {
    const caller = callerOf(call);
    const audience: HoldAudience = caller.kind;
    // Told BEFORE anything runs, for a ferret's act: a sign-in's after-submit facts the ferret could have steered are
    // not kept. Until the call ends it counts on every page; then it is placed on the page it touched (I100).
    const note = caller.kind === 'agent' ? deps.acts?.acted(caller.ferret, false) : undefined;
    let page: ResolvedPage | undefined;
    try {
      page = await host.resolve(caller, key);
      return await typed(caller, audience, page, op, action);
    } finally {
      if (note !== undefined) note.placed(page === undefined ? undefined : await placedOn(caller, page));
    }
  };

  /** The page an act touched, for the sign-in lock: unknown (every page) when the browser cannot say (I100). */
  const placedOn = async (caller: PageCaller, page: ResolvedPage): Promise<ActedPage | undefined> =>
    host.actedPage === undefined ? undefined : await host.actedPage(caller, page).catch(() => undefined);

  const typed = async (
    caller: PageCaller,
    audience: HoldAudience,
    page: ResolvedPage,
    op: 'type' | 'fill',
    action: PageInputAction,
  ): Promise<ToolResult> => {
    const reference = surfaceReference(page);
    let outcome: PageInputOutcome = {};
    try {
      await actOnPage(kernel.act, { id: page.id, reference }, op, audience, async () => {
        outcome = await host.act(caller, page, action);
        return { status: 'done' };
      });
    } catch (error) {
      // An act that failed partway may still have moved the page or typed into it.
      deps.identities?.cleared(caller.ferret, page.id);
      throw await heldOrMasked(kernel, { id: page.id, reference }, op, audience, error);
    }
    const next = identityAfter(action, outcome, caller.kind === 'agent');
    if (next === 'clear') deps.identities?.cleared(caller.ferret, page.id);
    else deps.identities?.typed(caller.ferret, page.id, next.host, next.username);
    await host.drove?.(caller, page).catch(() => undefined);
    return { text: `Done on ${reference}.` };
  };

  /** Every tool answers a refusal or a failure as an error result, never a throw past the kernel. */
  const guarded =
    (handler: ToolHandler): ToolHandler =>
    async (call, raw) => {
      try {
        return await handler(call, raw);
      } catch (error) {
        // Already worded under a hold, or passed through the redactor here (I120): a message never leaves unmasked.
        const out = await heldOrMasked(kernel, undefined, undefined, 'agent', error);
        return failed(out.message === '' ? 'The call failed.' : out.message);
      }
    };

  const browser_type: ToolHandler = guarded(async (call, raw) => {
    const typed: BrowserTypeInput = parsed(BrowserTypeInputSchema, raw);
    return await input(call, typed.name, 'type', {
      action: 'type',
      ...(typed.selector === undefined ? {} : { selector: typed.selector }),
      ...(typed.ref === undefined ? {} : { ref: typed.ref }),
      text: typed.text,
      ...(typed.submit === true ? { submit: true } : {}),
      ...(typed.slowly === true ? { slowly: true } : {}),
    });
  });

  const browser_fill_form: ToolHandler = guarded(async (call, raw) => {
    const form = parsed(BrowserFillFormInputSchema, raw);
    return await input(call, form.name, 'fill', { action: 'fill-form', fields: form.fields });
  });

  const browser_request_input: ToolHandler = guarded(async (call, raw) => {
    const request = parsed(BrowserRequestInputSchema, raw);
    const caller = callerOf(call);
    const page = await host.resolve(caller, request.name);
    const reference = surfaceReference(page);
    if (request.push === true) {
      if (deps.approvals === undefined)
        throw new PageToolError('Phone approvals are not available on this machine: ask for the value instead.');
      return { text: (await deps.approvals.raise(caller, page, request)).summary };
    }
    if (caller.kind !== 'agent')
      throw new PageToolError('Only an agent asks its owner for values; you already have the page.');
    if (deps.vault === undefined) throw new PageToolError('Input requests are not available on this machine.');
    const raise: InputRaise = {
      target: { kind: 'page', key: page.name ?? page.id },
      prompt: request.prompt,
      fields: request.fields.map(field => ({
        id: field.id,
        ...(field.label === undefined ? {} : { label: field.label }),
        sensitivity: field.sensitivity,
        element:
          field.ref === undefined
            ? { kind: 'selector' as const, selector: field.selector ?? '' }
            : { kind: 'ref' as const, ref: field.ref },
      })),
      submit: request.submit ?? 'offer-owner',
      ...(request.expiresInSeconds === undefined ? {} : { expiresInSeconds: request.expiresInSeconds }),
      ...(request.blocking === undefined ? {} : { blocking: request.blocking }),
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.secretHint === undefined ? {} : { secretHint: request.secretHint }),
    };
    const raised = await deps.vault.raiseInput(caller.ferret, raise);
    if (!raised.ok) throw new PageToolError(raised.error);
    return {
      text: `Asked the owner for ${plural(request.fields.length, 'value')} (${raised.value}) for ${reference}. Wait with input_wait; do not type into those fields yourself.`,
      data: { request: raised.value },
    };
  });

  const browser_ask_owner: ToolHandler = guarded(async (call, raw) => {
    const ask = parsed(BrowserAskOwnerInputSchema, raw);
    const caller = callerOf(call);
    if (caller.kind !== 'agent')
      throw new PageToolError('Only an agent hands a surface to its owner; you already have it.');
    const page = await host.resolve(caller, ask.name);
    await host.askOwner(caller, page, ask.message);
    return {
      text: `Asked the owner to take over ${surfaceReference(page)}${ask.message === undefined ? '' : ' and told them what to do'}. Wait for them: read the surface to see when they are done.`,
    };
  });

  return { browser_type, browser_fill_form, browser_request_input, browser_ask_owner };
}
