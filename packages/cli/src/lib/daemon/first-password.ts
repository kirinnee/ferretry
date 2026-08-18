import { OPERATOR_PASSWORD_MIN_LENGTH, OperatorPasswordSchema } from '@ferretry/protocol';
import type { IDaemonOutput } from './ports.ts';

/**
 * The operator password, as much of it as SETTING THE FIRST ONE needs.
 *
 * TWO METHODS AND NO GETTER. Whether one exists is a fact a screen may know; the password itself is
 * not readable from anywhere in this product, and a port that could read one would be the hole. The
 * composition root satisfies this with the same grant gateway `fy daemon password set` uses, so this
 * flow cannot store a password the other command could not replace.
 */
interface IFirstPasswordGateway {
  /** Whether this machine already has an operator password. Never the password itself. */
  passwordSet(): Promise<boolean>;
  /** Stores the machine's first operator password. */
  setPassword(password: string): Promise<void>;
}

/** Reading a value a terminal must not echo. Satisfied structurally by the shipped prompt adapter. */
interface ISecretPrompt {
  askSecret(message: string): Promise<string>;
}

interface FirstPasswordDeps {
  readonly passwords: IFirstPasswordGateway;
  readonly prompt: ISecretPrompt;
  readonly out: IDaemonOutput;
  /**
   * Whether a PERSON is watching this invocation, asked rather than assumed.
   *
   * A function, not a boolean, so the answer is the one that is true when the question is asked rather
   * than when the controller was built.
   */
  readonly interactive: () => boolean;
  /** What a person types to run this binary, so every sentence below names a command they have. */
  readonly clientName: string;
}

/**
 * ASKING FOR THE FIRST OPERATOR PASSWORD AT THE MOMENT SOMEBODY IS ALREADY SETTING UP.
 *
 * ## THIS IS CONVENIENCE. IT IS NOT THE GUARANTEE, AND IT MUST NOT PRETEND TO BE
 *
 * The guarantee is that PAIRING refuses without a password, and it lives in the daemon — see
 * `PairingService.mint` and `docs/grants.md`. This exists because the natural moment to ask is when a
 * person is standing there starting the daemon, not when they are halfway through adding a phone.
 *
 * ## IT CAN NEVER BLOCK A START, AND THAT IS THE WHOLE DESIGN CONSTRAINT
 *
 * The daemon is also launched by systemd and launchd at login, with no terminal and nobody watching.
 * A prompt there would hang the unit until its timeout and the machine would silently stop running the
 * daemon at boot — strictly worse than the problem being solved. So:
 *
 * - **Nothing is asked unless this invocation is interactive.** Both ends of the terminal, checked
 *   through the same port every other CLI prompt uses.
 * - **Every failure here is a WARNING.** The daemon is already serving by the time this runs; turning
 *   "you did not want to set a password" or "the daemon did not answer" into a failed `start` would
 *   report a daemon that is up as a daemon that is down.
 * - **A service manager never reaches this code at all**, because a unit's `ExecStart` is the daemon
 *   executable rather than this command. That is asserted in `unit-file.test.ts` rather than assumed.
 *
 * ## SKIPPING IS A FIRST-CLASS ANSWER
 *
 * Pressing Enter sets nothing and says what that means. Local use of a passwordless machine is
 * untouched — that is the state every new install starts in — and the only thing it costs is pairing,
 * which says so with the same remedy at the moment somebody tries.
 */
export class FirstPasswordOffer {
  constructor(private readonly deps: FirstPasswordDeps) {}

  async offer(): Promise<void> {
    if (!this.deps.interactive()) return;
    if (!(await this.#missing())) return;
    this.deps.out.warn(this.#explanation());
    const candidate = await this.deps.prompt.askSecret('Operator password (Enter to skip): ');
    if (candidate.trim() === '') return this.deps.out.warn(this.#skipped());
    if (!OperatorPasswordSchema.safeParse(candidate).success) return this.deps.out.warn(this.#tooShort());
    const confirmation = await this.deps.prompt.askSecret('Type it again: ');
    if (confirmation !== candidate) return this.deps.out.warn(this.#mismatched());
    await this.#store(candidate);
  }

  /**
   * Whether this machine has no password YET — and `false` when the question could not be answered.
   *
   * FAILING CLOSED HERE MEANS ASKING NOTHING, which is the opposite of what it means in the daemon and
   * is right for the same reason: this surface can only ever ADD a password, so the cost of staying
   * quiet is that somebody is not offered one. Pairing still refuses on its own account, with its own
   * sentence, so nothing is lost except the convenience.
   */
  async #missing(): Promise<boolean> {
    try {
      return !(await this.deps.passwords.passwordSet());
    } catch (error) {
      this.deps.out.warn(
        `${this.#name} could not ask the daemon whether this machine has an operator password, so it is not offering to set one: ${message(error)}. Set one with \`${this.#name} daemon password set\`.`,
      );
      return false;
    }
  }

  async #store(password: string): Promise<void> {
    try {
      await this.deps.passwords.setPassword(password);
    } catch (error) {
      this.deps.out.warn(
        `the operator password was not set: ${message(error)}. The daemon is running; set one with \`${this.#name} daemon password set\` when you can.`,
      );
      return;
    }
    this.deps.out.success(
      'operator password set — this machine can pair a device now, and a change made from off this host needs the password first',
    );
  }

  /** Why the question is being asked, before it is asked. Never after the answer. */
  #explanation(): string {
    return `this machine has no operator password, so it cannot pair a device yet. A paired device can change the settings of whatever is already switched on here — including the agent fleet, which writes runnable files into your accounts — and the password is what stands in front of that. It is not your computer's login. Using Ferretry on this machine needs no password at all.`;
  }

  #skipped(): string {
    return `no password set — nothing about using this machine changes. Adding a device will ask for one; set it then, or now with \`${this.#name} daemon password set\`.`;
  }

  #tooShort(): string {
    return `that is shorter than ${String(OPERATOR_PASSWORD_MIN_LENGTH)} characters, so nothing was set. Try again with \`${this.#name} daemon password set\`.`;
  }

  #mismatched(): string {
    return `the two entries did not match, so nothing was set. Try again with \`${this.#name} daemon password set\`.`;
  }

  get #name(): string {
    return this.deps.clientName;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
