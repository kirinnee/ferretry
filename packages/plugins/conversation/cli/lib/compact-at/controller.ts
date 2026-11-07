import {
  type CompactAtPatch,
  type CompactAtPatchResult,
  describeCompactAt,
  type FerretCompactAt,
  parseCompactAt,
} from '../../../contract/index.ts';
import { CommandError } from '../errors.ts';
import type { ConversationOutput } from '../send/ports.ts';

/** The two routes `fy compact-at` speaks. */
export interface CompactAtGateway {
  read(ferret: string): Promise<FerretCompactAt>;
  write(ferret: string, change: CompactAtPatch): Promise<CompactAtPatchResult>;
}

/**
 * Reads or sets where one ferret compacts its conversation: `fy compact-at <ferret> [tokens|auto|inherit]`.
 *
 * With no value it reads. A value is `auto` (the harness's own trigger), a size like `250k` or `250000`, or `inherit`
 * (drop this ferret's own value so its sign-in's default applies again). A running ferret takes a change at its next
 * restart, and the answer says so.
 */
export class CompactAtController {
  constructor(
    private readonly gateway: CompactAtGateway,
    private readonly output: ConversationOutput,
  ) {}

  async run(reference: string, value: string | undefined, flags: { readonly json?: boolean } = {}): Promise<void> {
    const ferret = reference.trim();
    if (ferret === '') throw new CommandError('name the ferret to change');
    if (value === undefined) {
      const reading = await this.gateway.read(ferret);
      if (flags.json === true) this.output.out(JSON.stringify(reading, null, 2));
      else {
        this.output.out(
          `compact at ${describeCompactAt(reading.effective)}${reading.own === undefined ? ' (default)' : ''}`,
        );
        this.output.out(reading.note);
      }
      return;
    }
    const change = await this.gateway.write(ferret, { compactAt: wantedOf(value) });
    this.output.out(flags.json === true ? JSON.stringify(change, null, 2) : change.note);
  }
}

function wantedOf(value: string): CompactAtPatch['compactAt'] {
  if (value.trim().toLowerCase() === 'inherit') return 'inherit';
  const parsed = parseCompactAt(value);
  if (!parsed.ok) throw new CommandError(parsed.reason);
  return parsed.value;
}
