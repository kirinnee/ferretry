/** Git's GPG contract: signing goes to the memory signer; verification goes to GnuPG with only public keys. */
const word = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export function gpgShim(input: {
  readonly socket: string;
  readonly fingerprint: string;
  readonly home: string;
  readonly gpg: string;
  readonly curl: string;
}): string {
  return `#!/bin/sh
if [ "$#" = 3 ] && [ "$1" = '--status-fd=2' ] && [ "$2" = '-bsau' ] && [ "$3" = ${word(input.fingerprint)} ]; then
  ${word(input.curl)} --disable --fail --silent --show-error --noproxy '*' --max-time 30 --unix-socket ${word(input.socket)} -H 'Content-Type: application/octet-stream' --data-binary @- http://localhost/sign | {
    IFS= read -r status || exit 1
    case "$status" in '[GNUPG:] SIG_CREATED '*) printf '%s\\n' "$status" >&2 ;; *) exit 1 ;; esac
    cat
  }
else
  for arg do
    if [ "$arg" = '--verify' ]; then
      exec ${word(input.gpg)} --no-options --homedir ${word(input.home)} --no-auto-key-retrieve --no-auto-key-import "$@"
    fi
  done
  exit 1
fi
`;
}
