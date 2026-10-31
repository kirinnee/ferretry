import {
  type CopyMeta,
  type CopyPlan,
  type CopyRouteFrom,
  CopyRouteFromSchema,
  type CopyRouteTo,
  CopyRouteToSchema,
  type PasteRule,
  type PasteRuleCreate,
} from '@ferretry/protocol';
import type { CopyPorts } from './ports.ts';

/** Options every `fy copy` command accepts. */
export interface CopyCommandOptions {
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

/** `fy copy rules add` flags. */
export interface CopyRuleOptions extends CopyCommandOptions {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly count?: string | undefined;
  readonly expires?: string | undefined;
}

/** Said when a ferret reaches for the owner's command. */
export const COPY_FERRET_REFUSAL = "this is the owner's command; a ferret cannot approve its own pastes";

const UNITS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** `90`, `30m`, `2h` or `7d`, in seconds. */
export function parseLifetime(text: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/u.exec(text.trim());
  if (match === null) throw new Error(`--expires "${text}" is not a time like 30m, 2h or 7d`);
  return Number(match[1]) * (UNITS[match[2] === '' ? 's' : (match[2] as string)] ?? 1);
}

/** `command:gh`, `browser:https://github.com` or `clipboard:https://github.com`. */
export function parseFrom(text: string): CopyRouteFrom {
  const [kind, ...rest] = text.split(':');
  const value = rest.join(':');
  const parsed = CopyRouteFromSchema.safeParse(kind === 'command' ? { kind, program: value } : { kind, origin: value });
  if (!parsed.success)
    throw new Error(`--from "${text}" is not command:<program>, browser:<origin> or clipboard:<origin>`);
  return parsed.data;
}

/** `terminal:vercel`, `browser:https://vercel.com` or `secret:VERCEL_TOKEN`. */
export function parseTo(text: string): CopyRouteTo {
  const [kind, ...rest] = text.split(':');
  const value = rest.join(':');
  const parsed = CopyRouteToSchema.safeParse(
    kind === 'terminal'
      ? { kind, program: value }
      : kind === 'secret'
        ? { kind, name: value }
        : { kind, origin: value },
  );
  if (!parsed.success) throw new Error(`--to "${text}" is not terminal:<program>, browser:<origin> or secret:<NAME>`);
  return parsed.data;
}

const fromText = (from: CopyRouteFrom): string =>
  from.kind === 'command' ? `command:${from.program}` : `${from.kind}:${from.origin}`;
const toText = (to: CopyRouteTo): string =>
  to.kind === 'terminal'
    ? `terminal:${to.program}`
    : to.kind === 'secret'
      ? `secret:${to.name}`
      : `browser:${to.origin}`;

function renderRule(rule: PasteRule): string {
  return [
    rule.id.slice(0, 8),
    `${fromText(rule.from)} → ${toText(rule.to)}`,
    rule.sessionId === undefined ? 'any session' : `session ${rule.sessionId}`,
    rule.remaining === undefined ? 'no count' : `${String(rule.remaining)} left`,
    rule.expiresAt === undefined ? 'no expiry' : `until ${rule.expiresAt}`,
    `used ${String(rule.used)}`,
  ].join('  ');
}

function renderCopy(copy: CopyMeta): string {
  const from = copy.from.origin ?? copy.from.path ?? copy.from.program ?? copy.from.kind;
  return `${copy.handle}  ${copy.state}  ${String(copy.length)} chars from ${from}  until ${copy.expiresAt}  pasted ${String(copy.uses)}${copy.exposure.transcript === 'found' ? '  [seen by the ferret before it was sealed]' : ''}`;
}

function renderPlan(plan: CopyPlan): string {
  const items = plan.items.map(
    (item, index) =>
      `   ${String(index + 1)}. ${fromText(item.from)} → ${toText(item.to)}  the agent says: ${item.why}`,
  );
  return [
    `${plan.id.slice(0, 8)}  !${plan.agendaItemId}  session ${plan.sessionId}  until ${plan.expiresAt}`,
    ...items,
  ].join('\n');
}

/**
 * Drives `fy copy`: the owner reads what copies a session holds (descriptions only), approves routes in advance,
 * and answers a ferret's paste plan. Refused inside a ferret's pane, and again by the daemon.
 */
export class CopyController {
  constructor(private readonly ports: CopyPorts) {}

  async list(options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const session = options.session?.trim() ?? '';
    if (session === '') throw new Error('name the session with --session <id>: copies belong to one session');
    const copies = await this.ports.gateway.copies(session);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ copies }, null, 2)
        : copies.length === 0
          ? `${session} holds no secure copies`
          : copies.map(renderCopy).join('\n'),
    );
  }

  async rules(options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const list = await this.ports.gateway.rules();
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(list, null, 2)
        : list.rules.length === 0
          ? 'no pastes are approved in advance'
          : list.rules.map(renderRule).join('\n'),
    );
  }

  async addRule(options: CopyRuleOptions): Promise<void> {
    this.#refuseFerret();
    if (options.from === undefined || options.to === undefined)
      throw new Error('a rule needs --from and --to, e.g. --from command:gh --to terminal:vercel');
    const count = options.count === undefined ? undefined : Number(options.count);
    if (count !== undefined && (!Number.isInteger(count) || count < 1))
      throw new Error(`--count "${options.count ?? ''}" is not a whole number of pastes`);
    const request: PasteRuleCreate = {
      from: parseFrom(options.from),
      to: parseTo(options.to),
      ...(options.session === undefined ? {} : { sessionId: options.session.trim() }),
      ...(count === undefined ? {} : { count }),
      ...(options.expires === undefined ? {} : { expiresInSeconds: parseLifetime(options.expires) }),
    };
    const rule = await this.ports.gateway.addRule(request);
    this.ports.out.success(
      options.json === true ? JSON.stringify(rule, null, 2) : `Approved in advance: ${renderRule(rule)}`,
    );
  }

  async removeRule(reference: string, options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const rule = await this.#rule(reference);
    await this.ports.gateway.removeRule(rule.id);
    this.ports.out.success(
      options.json === true ? JSON.stringify({ removed: rule.id }) : `Removed ${renderRule(rule)}`,
    );
  }

  async plans(options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const { plans } = await this.ports.gateway.plans();
    const shown = options.session === undefined ? plans : plans.filter(plan => plan.sessionId === options.session);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify({ plans: shown }, null, 2)
        : shown.length === 0
          ? 'no paste plans are waiting'
          : shown.map(renderPlan).join('\n'),
    );
  }

  /** Allows the numbered items of a plan (1-based, as listed); none declines it. */
  async approve(reference: string, numbers: readonly string[], options: CopyCommandOptions): Promise<void> {
    this.#refuseFerret();
    const { plans } = await this.ports.gateway.plans();
    const plan = unique(
      plans.filter(candidate => candidate.id.startsWith(reference.trim())),
      reference,
      'plan',
    );
    const items = numbers.map(number => {
      const index = Number(number) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= plan.items.length)
        throw new Error(`"${number}" is not one of the plan's items 1 to ${String(plan.items.length)}`);
      return index;
    });
    const settled = await this.ports.gateway.approve(plan.sessionId, plan.id, items);
    this.ports.out.success(
      options.json === true
        ? JSON.stringify(settled, null, 2)
        : settled.state === 'declined'
          ? `Declined the plan ${plan.id.slice(0, 8)}.`
          : `Allowed ${(settled.approved ?? []).map(index => String(index + 1)).join(', ')} of the plan ${plan.id.slice(0, 8)}: each goes through once, until ${settled.expiresAt}.`,
    );
  }

  async #rule(reference: string): Promise<PasteRule> {
    const { rules } = await this.ports.gateway.rules();
    return unique(
      rules.filter(rule => rule.id.startsWith(reference.trim())),
      reference,
      'rule',
    );
  }

  #refuseFerret(): void {
    const credential = this.ports.agentCredential?.trim() ?? '';
    const own = this.ports.ownSessionId?.trim() ?? '';
    if (own !== '' || credential !== '') throw new Error(COPY_FERRET_REFUSAL);
  }
}

function unique<T>(found: readonly T[], reference: string, what: string): T {
  if (reference.trim() === '')
    throw new Error(`name the ${what} by its id (see \`copy ${what === 'rule' ? 'rules' : 'plan'} ls\`)`);
  if (found.length === 0) throw new Error(`no ${what} starts with "${reference}"`);
  if (found.length > 1) throw new Error(`more than one ${what} starts with "${reference}": give more of its id`);
  return found[0] as T;
}
