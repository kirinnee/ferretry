import { relative, isAbsolute, sep } from 'node:path';

const within = (root: string, cwd: string): boolean => {
  const part = relative(root, cwd);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};

/** Shared by terminal opens and ferret starts/resumes; held through the actual pane creation. */
export class WorktreeGuard {
  private readonly removing = new Set<string>();
  private readonly launching = new Map<Promise<void>, string>();

  constructor(private readonly realPath: (path: string) => Promise<string>) {}

  async launch<T>(cwd: string, refused: () => T, work: () => Promise<T>): Promise<T> {
    const real = await this.realPath(cwd);
    if ([...this.removing].some(root => within(root, real))) return refused();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    this.launching.set(held, real);
    try {
      return await work();
    } finally {
      this.launching.delete(held);
      release();
    }
  }

  /** Reserve BEFORE waiting: new admissions refuse while earlier admissions finish and evidence is sampled. */
  async withRemoval<T>(path: string, work: () => Promise<T>): Promise<T> {
    const real = await this.realPath(path);
    if (this.removing.has(real)) throw new Error('this checkout is already being removed');
    this.removing.add(real);
    try {
      await Promise.all([...this.launching].filter(([, cwd]) => within(real, cwd)).map(([held]) => held));
      return await work();
    } finally {
      this.removing.delete(real);
    }
  }
}
