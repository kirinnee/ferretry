import type { SecretList } from '@ferretry/protocol';

/** The sentence that has to be true, printed where a person will read it before trusting the store. */
export const SECRET_HONESTY =
  'Agents can USE these without holding one — the value goes into the child ferretry spawns, never into the agent. It is not a defence against an agent deliberately trying to leak a secret it may use.';

function age(updatedAt: string, createdAt: string): string {
  return updatedAt === createdAt ? `set ${updatedAt}` : `changed ${updatedAt}`;
}

/**
 * The listing.
 *
 * There is nothing here but names and instants, because that is all the daemon will say. A person
 * cannot read a value back — the listing is how they confirm one EXISTS and when it last moved.
 */
export function renderSecretList(list: SecretList): string {
  if (list.health === 'damaged')
    return [
      'This daemon cannot read its secret store.',
      list.diagnosis ?? 'no diagnosis was given',
      '',
      'It is NOT empty. Do not set these again until the store is readable, or you will write over entries that are still there.',
    ].join('\n');

  const lines: string[] = [];
  lines.push(
    list.secrets.length === 0
      ? 'No secrets on this daemon.'
      : list.secrets.map(secret => `  ${secret.name}  ${age(secret.updatedAt, secret.createdAt)}`).join('\n'),
  );

  const unresolved = list.references.filter(reference => !reference.resolved);
  if (unresolved.length > 0) {
    lines.push('', 'Configuration references a secret this daemon does not hold:');
    for (const reference of unresolved) lines.push(`  ${reference.name}  ← ${reference.origin}`);
    lines.push('Anything that uses one of these will be refused rather than run with a blank value.');
  }

  lines.push('', SECRET_HONESTY);
  return lines.join('\n');
}
