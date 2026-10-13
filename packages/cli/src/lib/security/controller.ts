import { SECURITY_SETTING_FIELDS, type SecuritySettingField, type SecuritySettingsPatch } from '@ferretry/protocol';
import type { ISecurityGateway, ISecurityOutput } from './ports.ts';
import { renderSecurity, renderSecurityChange } from './render.ts';

/** Flags the security commands accept. */
export interface SecurityCommandOptions {
  readonly json?: boolean;
}

export interface SecurityControllerDeps {
  readonly gateway: ISecurityGateway;
  readonly out: ISecurityOutput;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

const SWITCH_WORDS: Readonly<Record<string, boolean>> = { on: true, true: true, off: false, false: false };

/**
 * Drives `fy daemon security …`. Non-interactive throughout: this command line holds the admin token,
 * so it is the one caller allowed to loosen a setting and it never asks to confirm.
 *
 * THE BOUNDS ARE THE DAEMON'S. This parses only the SHAPE of a value (an integer, an on/off word) and
 * lets the daemon refuse an out-of-range one, so its refusal sentence reaches the person word for word
 * instead of a second copy of the limits drifting from the first.
 */
export class SecurityController {
  constructor(private readonly deps: SecurityControllerDeps) {}

  async show(options: SecurityCommandOptions): Promise<void> {
    const view = await this.deps.gateway.read();
    this.deps.out.success(options.json === true ? JSON.stringify(view) : renderSecurity(view, this.deps.clientName));
  }

  async set(field: string, value: string): Promise<void> {
    const target = SECURITY_SETTING_FIELDS.find(candidate => candidate === field);
    if (target === undefined) {
      this.fail(
        `${JSON.stringify(field)} is not a security setting; expected one of ${SECURITY_SETTING_FIELDS.join(', ')}`,
      );
      return;
    }
    const patch = parseValue(target, value);
    if (typeof patch === 'string') {
      this.fail(patch);
      return;
    }
    const change = await this.deps.gateway.change(patch);
    this.deps.out.success(renderSecurityChange(target, change));
  }

  private fail(message: string): void {
    this.deps.out.error(message);
    this.deps.out.setExitCode(1);
  }
}

/** The patch for one field, or the sentence saying why the value cannot be one. */
function parseValue(field: SecuritySettingField, value: string): SecuritySettingsPatch | string {
  if (field === 'presenceOnOpen') {
    const word = SWITCH_WORDS[value.trim().toLowerCase()];
    return word === undefined
      ? `${field} takes on, off, true or false, not ${JSON.stringify(value)}`
      : { [field]: word };
  }
  if (!/^[+-]?\d+$/u.test(value.trim())) return `${field} takes a whole number, not ${JSON.stringify(value)}`;
  return { [field]: Number.parseInt(value, 10) };
}
