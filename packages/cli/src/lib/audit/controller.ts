import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from '@ferretry/protocol';
import type { IAuditGateway, IAuditOutput } from './ports.ts';
import { renderAudit } from './render.ts';

/** Flags `fy daemon audit` accepts. `limit` arrives as the raw text the shell gave. */
export interface AuditCommandOptions {
  readonly json?: boolean;
  readonly limit?: string;
}

export interface AuditControllerDeps {
  readonly gateway: IAuditGateway;
  readonly out: IAuditOutput;
}

/**
 * Drives `fy daemon audit`.
 *
 * A READ, so it takes no password. A limit above what the daemon will serve is capped rather than
 * refused: asking for "everything" and getting the most the daemon allows is what the person meant.
 * A limit that is not a positive whole number is refused, because guessing at it would hide a typo.
 */
export class AuditController {
  constructor(private readonly deps: AuditControllerDeps) {}

  async show(options: AuditCommandOptions): Promise<void> {
    const limit = parseLimit(options.limit);
    if (limit === undefined) {
      this.deps.out.error(
        `--limit must be a whole number of 1 or more; the most that can be shown is ${String(AUDIT_MAX_LIMIT)}`,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    const view = await this.deps.gateway.read(limit);
    this.deps.out.success(options.json === true ? JSON.stringify(view) : renderAudit(view));
  }
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return AUDIT_DEFAULT_LIMIT;
  if (!/^\d+$/u.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return parsed < 1 ? undefined : Math.min(parsed, AUDIT_MAX_LIMIT);
}
