/**
 * The few CLI helpers `fy rules` shares with other owners' commands, copied byte for byte from today's
 * `packages/cli/src/lib/{daemon/owner-only,input/render,plan/controller}.ts` (bb89d054d).
 *
 * TODO(contract): owned by the `fy` shell (owner-only refusal), the Vault (`showUntrusted`) and Agenda/Asks (`fy plan`'s
 * `parseLifetime`, `unique`); no contract exports them.
 */

/**
 * Said, whatever the verb, when one of the owner's commands (`fy rules`, `fy plan`, `fy copy`, `fy input`) runs inside
 * a ferret's pane or with an agent's credential. Neutral on purpose: a read is refused there as well as a change.
 */
export const OWNER_COMMAND_REFUSAL = "this is the owner's command; a ferret's pane can't run it";

/** Throws {@link OWNER_COMMAND_REFUSAL} inside a ferret's pane, before anything is asked of the daemon. */
export function refuseOwnerCommandInPane(caller: {
  readonly ownSessionId: string | undefined;
  readonly agentCredential: string | undefined;
}): void {
  if ((caller.ownSessionId?.trim() ?? '') !== '' || (caller.agentCredential?.trim() ?? '') !== '')
    throw new Error(OWNER_COMMAND_REFUSAL);
}

const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Untrusted text made visible: a control or format character is spelled out, never sent to the terminal. */
export function showUntrusted(value: string): string {
  return value.replaceAll(UNSEEN, char => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`;
  });
}

const UNITS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** `90`, `30m`, `2h` or `7d`, in seconds. */
export function parseLifetime(text: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/u.exec(text.trim());
  if (match === null) throw new Error(`--expires "${text}" is not a time like 30m, 2h or 7d`);
  return Number(match[1]) * (UNITS[match[2] === '' ? 's' : (match[2] as string)] ?? 1);
}

/** The one item whose id starts with `reference`, or the sentence that says why there is none. */
export function unique<T>(found: readonly T[], reference: string, what: string, listing: string): T {
  if (reference.trim() === '') throw new Error(`name the ${what} by its id (see \`${listing}\`)`);
  if (found.length === 0) throw new Error(`no ${what} starts with "${reference}"`);
  if (found.length > 1) throw new Error(`more than one ${what} starts with "${reference}": give more of its id`);
  return found[0] as T;
}

/** Whether a refused call answered this HTTP status (the client's error carries `status`). */
export const refusedWith = (error: unknown, status: number): boolean =>
  typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === status;

/** Whether a refused call answered this error code (the client's error carries `code`). */
export const refusedCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
