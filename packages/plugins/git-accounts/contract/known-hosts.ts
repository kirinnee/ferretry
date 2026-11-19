/**
 * GitHub's published SSH host keys, pinned (`GET https://api.github.com/meta`, field `ssh_keys`; the same lines are on
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
 * A push is checked against THESE with `StrictHostKeyChecking=yes`, so a first connection is not trust-on-first-use.
 *
 * UPDATE PATH: when GitHub rotates a key (it announced one rotation, in March 2023), replace the line below with the
 * new `ssh_keys` entry, keep the old one for a release so a machine that updates late still connects, and add the
 * new SHA256 fingerprint to the test that compares them (`tests/unit/ssh-keys.test.ts`).
 */
export const GITHUB_HOST_KEYS = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
] as const;

/** The SHA256 fingerprints GitHub publishes for those keys (`ssh_key_fingerprints` in the same answer). */
export const GITHUB_HOST_KEY_FINGERPRINTS = [
  'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
  'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
] as const;

/** The text of a `known_hosts` file that pins github.com. */
export function githubKnownHosts(): string {
  return `${GITHUB_HOST_KEYS.map(key => `github.com ${key}`).join('\n')}\n`;
}
