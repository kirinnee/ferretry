import { homedir } from 'node:os';
import type { EnvironmentPort, StateHomeInput } from '../../lib/index.ts';

export class RuntimeEnvironment implements EnvironmentPort {
  constructor(
    private readonly values: Readonly<Record<string, string | undefined>> = process.env,
    private readonly userHome: () => string = homedir,
  ) {}

  stateHomeInput(): StateHomeInput {
    return {
      fyHome: this.values.FY_HOME,
      homeDirectory: this.userHome(),
    };
  }
}
