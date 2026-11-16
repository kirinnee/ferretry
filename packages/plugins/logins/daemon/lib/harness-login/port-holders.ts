/**
 * Who is listening on Codex's sign-in callback port, and whether that listener may be stopped.
 *
 * A Codex link sign-in listens on this machine's callback port until it exits. One left behind — by a
 * daemon that was killed before it could end its sign-ins, or a `codex login` somebody ran by hand and
 * abandoned — keeps the port, and every later link sign-in fails because Codex cannot listen. "Start
 * over" clears that leftover, and ONLY that: a program is stopped when it is PROVEN to be a leftover
 * Codex sign-in, and anything else on the port is named in words and left alone. A local proxy the owner
 * runs on that port is their business, not this daemon's.
 *
 * The proof is two facts, both required:
 *
 * - **the same OS user as this daemon** — a program another user runs is not ours to stop, and the OS
 *   would refuse anyway;
 * - **its command line is a Codex login** — an argument whose file name is `codex` (or Codex's own
 *   `codex.js` launcher) followed, anywhere later, by the `login` subcommand. That is the shape this
 *   daemon launches (`codex -c … login --device-auth`) and the shape a person types.
 *
 * Anything the reader could not establish — no owner, no command line — is NOT a proof, so it is
 * treated as somebody else's.
 *
 * Everything here is PURE. Reading the port table and stopping a program are the adapter's.
 */

/** One program listening on a callback port, as far as this machine would say. */
export interface CallbackPortHolder {
  readonly port: number;
  /** Absent when the table would not say — a listener another user owns, which nothing here can stop. */
  readonly pid: number | undefined;
  /** The program's short name, as the port table reports it. */
  readonly name: string;
  /** Its OS user id, when the table or the program list says. */
  readonly uid: number | undefined;
  /** Its full command line, when the program list says. */
  readonly commandLine: string | undefined;
}

const CODEX_PROGRAM = /^codex(?:\.js|\.mjs)?$/u;

const baseName = (argument: string): string => argument.slice(argument.lastIndexOf('/') + 1);

/** Whether this command line runs Codex's own `login`. */
export function isCodexLoginCommand(commandLine: string): boolean {
  const words = commandLine.trim().split(/\s+/u);
  const program = words.findIndex(word => CODEX_PROGRAM.test(baseName(word)));
  return program !== -1 && words.slice(program + 1).includes('login');
}

/** Whether this holder is proven to be a leftover Codex sign-in this daemon may stop. */
export function isLeftoverCodexLogin(
  holder: CallbackPortHolder,
  ownUid: number | undefined,
): holder is CallbackPortHolder & { readonly pid: number } {
  if (holder.pid === undefined || ownUid === undefined || holder.uid !== ownUid) return false;
  return holder.commandLine !== undefined && isCodexLoginCommand(holder.commandLine);
}

/** Why a holder was left on its port. */
export type HeldVerdict = 'not-codex' | 'could-not-stop';

/**
 * The holders left on the callback ports, in words a person can act on: each program once, with its pid
 * and every port it holds — never more of its command line than its name.
 */
export function heldPortsWords(
  held: readonly { readonly holder: CallbackPortHolder; readonly verdict: HeldVerdict }[],
): string {
  const programs = new Map<string, { holder: CallbackPortHolder; verdict: HeldVerdict; ports: number[] }>();
  for (const { holder, verdict } of held) {
    const key = `${String(holder.pid)}|${holder.name}|${verdict}`;
    const known = programs.get(key);
    if (known === undefined) programs.set(key, { holder, verdict, ports: [holder.port] });
    else if (!known.ports.includes(holder.port)) known.ports.push(holder.port);
  }
  return [...programs.values()]
    .map(({ holder, verdict, ports }) => {
      const where = ports.length === 1 ? `port ${String(ports[0])} is` : `ports ${ports.join(' and ')} are`;
      const who = holder.pid === undefined ? holder.name : `"${holder.name}" (pid ${String(holder.pid)})`;
      const why =
        verdict === 'not-codex'
          ? 'which is not a Codex sign-in, so Ferretry will not stop it'
          : 'a leftover Codex sign-in Ferretry could not stop';
      return `${where} in use by ${who}, ${why}`;
    })
    .join('; ');
}

/**
 * The listeners in `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpcu` output.
 *
 * Field output is one field per line, each led by its letter: `p` starts a program, and `c` (command
 * name) and `u` (user id) belong to the last `p`. A program listening on two addresses appears once.
 */
export function parseLsofListeners(
  output: string,
): readonly { readonly pid: number; readonly name: string; readonly uid: number | undefined }[] {
  const found: { pid: number; name: string; uid: number | undefined }[] = [];
  let current: { pid: number; name: string; uid: number | undefined } | undefined;
  for (const line of output.split('\n')) {
    const field = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (field === 'p' && /^\d+$/u.test(value)) {
      current = found.find(entry => entry.pid === Number(value));
      if (current === undefined) {
        current = { pid: Number(value), name: '', uid: undefined };
        found.push(current);
      }
    } else if (field === 'c' && current !== undefined && current.name === '') current.name = value;
    else if (field === 'u' && current !== undefined && /^\d+$/u.test(value)) current.uid = Number(value);
  }
  return found.map(entry => ({ ...entry, name: entry.name === '' ? 'an unnamed program' : entry.name }));
}

/**
 * The listeners in `ss -Hltnp 'sport = :<port>'` output.
 *
 * Each row ends in `users:(("name",pid=123,fd=4),…)`. A row with no `users:` part is a listener owned by
 * another user, which `ss` will not describe — it is reported with no pid, so nothing can stop it.
 */
export function parseSsListeners(
  output: string,
): readonly { readonly pid: number | undefined; readonly name: string }[] {
  const found: { pid: number | undefined; name: string }[] = [];
  for (const row of output.split('\n')) {
    if (row.trim() === '') continue;
    const users = [...row.matchAll(/\("([^"]*)",pid=(\d+)/gu)];
    if (users.length === 0) found.push({ pid: undefined, name: 'a program run by another user' });
    for (const user of users) {
      const pid = Number(user[2]);
      if (!found.some(entry => entry.pid === pid)) found.push({ pid, name: user[1] ?? '' });
    }
  }
  return found;
}

/** `ps -o uid=,args= -p <pid>`: the user id, then the whole command line. Undefined when it is gone. */
export function parsePsLine(output: string): { readonly uid: number; readonly commandLine: string } | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(output.split('\n')[0] ?? '');
  return match === null ? undefined : { uid: Number(match[1]), commandLine: match[2] ?? '' };
}
