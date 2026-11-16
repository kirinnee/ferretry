/**
 * Programs that ask a person for a secret on their own terminal. A shell or an interpreter is NOT one: it
 * will read whatever is typed and run it, which is why a request aimed at a bare shell is an amber card the
 * owner must trust by hand (D3), not a recognised consumer.
 */
const RECOGNISED = new Set([
  'sudo',
  'su',
  'doas',
  'login',
  'passwd',
  'ssh',
  'ssh-add',
  'ssh-keygen',
  'scp',
  'sftp',
  'gpg',
  'gpg2',
  'kinit',
  'mysql',
  'psql',
  'docker',
  'npm',
  'op',
]);

const RECOGNISED_PREFIXES = ['pinentry', 'git-credential'] as const;

/** Whether `comm` (a program name, or a path to one) is a program that asks for a secret. */
export function recognisedConsumer(comm: string): boolean {
  const name = (comm.split('/').pop() ?? '').toLowerCase();
  return RECOGNISED.has(name) || RECOGNISED_PREFIXES.some(prefix => name.startsWith(prefix));
}
