import { $ } from 'bun';

/** Scaffold-owned shell port — structurally matches any domain shell port the glue bridges. */
export interface IShellRunner {
  platform(): Promise<string>;
}

/** Bun Shell ($) — zero-dependency, safely escaped shell calls. */
export class BunShell implements IShellRunner {
  async platform(): Promise<string> {
    return (await $`uname -srm`.text()).trim();
  }
}
