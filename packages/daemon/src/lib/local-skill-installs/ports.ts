/** A refusal in the local-copy contract's vocabulary, with the status a route answers it with. */
import type { LocalSkillRefusal } from '@ferretry/protocol';

export class LocalSkillRefusalError extends Error {
  constructor(
    readonly code: LocalSkillRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LocalSkillRefusalError';
  }
}
