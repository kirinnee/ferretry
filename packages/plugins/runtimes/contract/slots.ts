/**
 * THE SLOTS RUNTIMES OFFERS (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * The Add runtime page picks a login. A missing login is added, and one that needs sign-in is signed in, right there —
 * but how a login is made and how a harness signs in are Logins' to draw and to call, and Runtimes must not know them.
 * So the page OFFERS two slots and mounts whatever panels an installed plugin contributes: Logins contributes its
 * add-login panel and its sign-in panel. Neither half imports the other — the slot names and the props below are the
 * whole agreement (Logins writes the two names in its own contract, because Runtimes already needs Logins and Logins
 * cannot import Runtimes; the shell's slot test pairs them). A daemon whose Logins panels are not placed shows the page
 * with a link to Logins' Sign-ins tab instead.
 *
 * The props are plain data and callbacks (no framework type: this is a contract). **No token and no secret crosses
 * here**: a panel answers only with a login's id or a bare "signed in" — what a sign-in needs is Logins' own, and the
 * daemon holds none of it while it runs (docs/design/harness-login.md).
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { isSupportedHarnessKey } from './harness-words.ts';

/** Under the page's login list: Logins' add-login panel (a Claude Code or Codex sign-in, or a provider key). */
export const ADD_RUNTIME_LOGIN_SLOT = 'runtimes.add-runtime-login' as const;
/** Under a picked login that needs sign-in: Logins' sign-in panel for that login (the panel's `subject`). */
export const ADD_RUNTIME_SIGN_IN_SLOT = 'runtimes.add-runtime-sign-in' as const;

/** Every slot the Add runtime page offers, in one list a test can pair against the panels Logins contributes. */
export const ADD_RUNTIME_SLOTS = [ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT] as const;

/**
 * Under an MCP server's row in the Profiles library: where that server stands on this machine. What a server's status
 * is, how it is read and Check / Sign in are MCP's to draw; Runtimes only knows which component the row is (the panel's
 * `subject`) and how many runtimes use it. Runtimes cannot import MCP's half and MCP writes no second copy of the name.
 * Where no panel is placed the row is drawn without a footer.
 */
export const COMPONENT_MCP_SLOT = 'runtimes.component-mcp' as const;

/** Every slot Runtimes' pages offer, in one list a test can pair against the panels other plugins contribute. */
export const RUNTIMES_SLOTS = [...ADD_RUNTIME_SLOTS, COMPONENT_MCP_SLOT] as const;
export type RuntimesSlot = (typeof RUNTIMES_SLOTS)[number];

/** What the component slot hands its panels, besides the shell's `subject` (the MCP component's name). */
export interface ComponentMcpSlotProps {
  /** How many runtimes' profiles carry the component: none means no ferret starts it. */
  readonly usedByRuntimes: number;
}

export function isComponentMcpSlotProps(props: unknown): props is ComponentMcpSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const count = (props as Record<string, unknown>).usedByRuntimes;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0;
}

/** What the add-login slot hands its panels. */
export interface AddRuntimeLoginSlotProps {
  /** Told the new login's id once it is added: the page re-reads the machine and picks it. */
  readonly onAdded: (id: string) => void;
}

/** What the sign-in slot hands its panels, besides the shell's `subject` (the login's id). */
export interface AddRuntimeSignInSlotProps {
  /** The CLI the login signs in to. */
  readonly harness: HarnessKey;
  /** Told when the sign-in finished, carrying nothing: the page re-reads the machine. */
  readonly onSignedIn: () => void;
}

/** Narrowings for a contributing panel: the props are untyped at the shell, so each panel checks what it reads. */
export function isAddRuntimeLoginSlotProps(props: unknown): props is AddRuntimeLoginSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  return typeof (props as Record<string, unknown>).onAdded === 'function';
}

export function isAddRuntimeSignInSlotProps(props: unknown): props is AddRuntimeSignInSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  // A panel is offered for a harness Runtimes has behaviour for; any other harness is offered none, never Claude's.
  return (
    typeof candidate.harness === 'string' &&
    isSupportedHarnessKey(candidate.harness) &&
    typeof candidate.onSignedIn === 'function'
  );
}
