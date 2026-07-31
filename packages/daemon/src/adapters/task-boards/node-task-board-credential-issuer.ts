import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TaskBoardCredentialIssuer, TaskBoardSecret } from '../../lib/task-boards/types.ts';

/**
 * 256 bits, the same width `NodeSessionCredentialIssuer` mints a session credential at. A board
 * capability is the only thing standing between one teammate and another's board, so it is not a
 * shorter secret than the identity it is checked beside.
 */
const CAPABILITY_BYTES = 32;

/**
 * Board ids, grant ids and capabilities, over the platform CSPRNG.
 *
 * The domain never generates its own material — every service takes the ids and secrets it will use
 * as a `material` argument — so the reducers stay pure and a test drives them with fixed values while
 * production draws from the same place the session credential does.
 */
export class NodeTaskBoardCredentialIssuer implements TaskBoardCredentialIssuer {
  constructor(
    private readonly random: (size: number) => Buffer = randomBytes,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  /**
   * A fresh id, prefixed by what it names.
   *
   * The prefix is not decoration: a board id and a grant id both travel in the same audit detail
   * records, and one that could be mistaken for the other would make the audit unreadable at exactly
   * the moment somebody is reading it to find out who granted what.
   */
  id(kind: 'board' | 'grant'): string {
    return `${kind}-${this.uniqueId()}`;
  }

  capability(): TaskBoardSecret {
    const value = this.random(CAPABILITY_BYTES).toString('base64url');
    return { value, hash: this.hash(value) };
  }

  hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
