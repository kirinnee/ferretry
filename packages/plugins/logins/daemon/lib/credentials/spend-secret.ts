import type { SecretName } from '@ferretry/core-vault/contract';
import type { LoginView } from '../../../contract/index.ts';

/**
 * The secret a login's key is held under, read from THAT LOGIN'S OWN record and never from a caller: the one secret the
 * named variable of an environment login is made from. `undefined` for a login that is not made from environment
 * variables, a variable that does not exist, is plain or hidden, or is made from more than one secret — the spend is then
 * refused, so a caller that guesses a variable name reaches nothing a login does not already hold.
 */
export function spendSecretOf(login: LoginView | undefined, variable: string): SecretName | undefined {
  if (login?.store !== 'environment') return undefined;
  const held = login.environment?.variables.find(candidate => candidate.name === variable);
  return held?.kind === 'secret' && held.secrets.length === 1 ? (held.secrets[0] as SecretName) : undefined;
}
