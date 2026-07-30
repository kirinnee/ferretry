import inquirer from 'inquirer';

/** Interactive-input port for the CLI controllers (never used off a TTY). */
export interface IPrompt {
  ask(message: string): Promise<string>;
}

export class InquirerPrompt implements IPrompt {
  constructor(private readonly client: Pick<typeof inquirer, 'prompt'> = inquirer) {}

  async ask(message: string): Promise<string> {
    const { answer } = await this.client.prompt<{ answer: string }>([{ type: 'input', name: 'answer', message }]);
    return answer;
  }
}
