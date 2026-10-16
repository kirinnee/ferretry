import inquirer from 'inquirer';

/** Interactive-input port for the CLI controllers (never used off a TTY). */
export interface IPrompt {
  ask(message: string): Promise<string>;
  /**
   * Like {@link ask}, but nothing typed is ever echoed to the screen — for a secret value (a provider
   * key) that must never land in a terminal's scrollback or a screen a person is sharing.
   */
  askHidden(message: string): Promise<string>;
}

export class InquirerPrompt implements IPrompt {
  constructor(private readonly client: Pick<typeof inquirer, 'prompt'> = inquirer) {}

  async ask(message: string): Promise<string> {
    const { answer } = await this.client.prompt<{ answer: string }>([{ type: 'input', name: 'answer', message }]);
    return answer;
  }

  async askHidden(message: string): Promise<string> {
    // No `mask`: inquirer's password prompt then echoes nothing at all while typing, not even `*`.
    const { answer } = await this.client.prompt<{ answer: string }>([{ type: 'password', name: 'answer', message }]);
    return answer;
  }
}
