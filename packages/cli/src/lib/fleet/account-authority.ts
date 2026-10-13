import type { FleetMachineView } from '@ferretry/protocol';
import { type AccountAuthority, type AccountCommandDeps, AccountCommandError } from './account-ports.ts';

type MachineAuthority = FleetMachineView['authority'];
type AuthorityDeps = Pick<AccountCommandDeps, 'gateway' | 'prompt' | 'interactive' | 'readPasswordFromStdin'>;

/** Why this caller may not change the machine at all, in words, per shared grant refusal. */
const REFUSALS: Record<MachineAuthority['applyRefusal'], string> = {
  'not-granted': "This caller is not allowed to change this machine's setup: the operator has not granted it.",
  'rate-limited': 'Too many wrong operator passwords were tried on this machine. Wait a few minutes and try again.',
  undetermined: "This machine's grant settings could not be read, so no change is allowed until they are fixed.",
  locked: 'This change needs the operator password.',
  granted: "This caller is not allowed to change this machine's setup.",
  ungated: "This caller is not allowed to change this machine's setup.",
};

/**
 * What one write must show, worked out before anything is staged.
 *
 * A caller ON this machine owes nothing, and is never asked. A caller off it may be locked — it must
 * unlock before it can even stage a change — and may owe the operator password again for the apply
 * itself. The password is read once per command, at most, and is never kept past it.
 */
export class WriteAuthority {
  #password: string | undefined;

  private constructor(
    private readonly deps: AuthorityDeps,
    private readonly permissions: MachineAuthority,
    private readonly unlock: string | undefined,
    password: string | undefined,
  ) {
    this.#password = password;
  }

  /** Read what this caller may do, and unlock now if staging needs it. Refuses with the reason. */
  static async open(deps: AuthorityDeps): Promise<WriteAuthority> {
    const { authority: permissions } = await deps.gateway.machine();
    if (permissions.mayApply) return new WriteAuthority(deps, permissions, undefined, undefined);
    if (permissions.applyRefusal !== 'locked') throw new AccountCommandError(REFUSALS[permissions.applyRefusal]);
    const password = await readOperatorPassword(deps);
    const unlock = await deps.gateway.unlock(password);
    return new WriteAuthority(deps, permissions, unlock, password);
  }

  /** What a read or a stage carries: the unlock, when there is one. */
  get current(): AccountAuthority {
    return this.unlock === undefined ? {} : { unlock: this.unlock };
  }

  /** What the apply carries: the unlock, and the operator password when the machine asks for it again. */
  async forApply(): Promise<AccountAuthority> {
    if (this.permissions.confirmation !== 'operator-password') return this.current;
    this.#password ??= await readOperatorPassword(this.deps);
    return { ...this.current, password: this.#password };
  }
}

/**
 * The operator password: asked for without echo at a terminal, read from standard input in a script.
 *
 * There is no flag for it, for the reason there is none on `daemon password set`: a value on the
 * command line is in the shell history and in the process list while the command runs.
 */
async function readOperatorPassword(deps: AuthorityDeps): Promise<string> {
  if (deps.interactive) return await deps.prompt.askSecret("This machine's operator password:");
  try {
    return await deps.readPasswordFromStdin();
  } catch {
    throw new AccountCommandError(
      "This change needs this machine's operator password. Pipe it into this command's standard input, and pass --yes.",
    );
  }
}
