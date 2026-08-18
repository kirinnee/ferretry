import inquirer from 'inquirer';

/** Interactive-input port for the CLI controllers (never used off a TTY). */
export interface IPrompt {
  ask(message: string): Promise<string>;
  /**
   * Reads a value the terminal must not echo.
   *
   * SEPARATE FROM `ask` BECAUSE THE ECHO IS THE POINT. A password typed into a terminal that repeats
   * it is a password in the scrollback of whoever was looking at that screen, and nothing takes it
   * back out. These are two different questions, so they are two methods rather than one with a flag
   * somebody can forget to pass.
   *
   * IT IS STILL NEVER USED OFF A TTY. Suppressing echo needs a terminal, and a prompt on a
   * non-interactive stdin would hang — which is precisely the failure the caller of this exists to
   * avoid, so the caller asks whether this invocation is interactive BEFORE it asks anything of a
   * person.
   */
  askSecret(message: string): Promise<string>;
}

export class InquirerPrompt implements IPrompt {
  constructor(private readonly client: Pick<typeof inquirer, 'prompt'> = inquirer) {}

  async ask(message: string): Promise<string> {
    const { answer } = await this.client.prompt<{ answer: string }>([{ type: 'input', name: 'answer', message }]);
    return answer;
  }

  /**
   * Inquirer's own password question: no echo, and no mask either.
   *
   * A MASK IS NOT FREE. `mask: '*'` discloses the LENGTH of what is being typed to anybody watching
   * the screen, which is the one thing a shoulder-surfer would otherwise have to guess. So nothing is
   * echoed at all, and the confirmation the caller asks for is what tells a person they typed what
   * they meant to.
   */
  async askSecret(message: string): Promise<string> {
    const { answer } = await this.client.prompt<{ answer: string }>([{ type: 'password', name: 'answer', message }]);
    return answer;
  }
}
