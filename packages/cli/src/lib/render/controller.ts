import { RENDER_GUIDE_TYPES, renderGuideSection, renderGuideSectionName } from './guide.ts';
import type { IRenderOutput } from './ports.ts';

/** A refusal `fy render` says in one sentence and exits non-zero on. */
export class RenderCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderCommandError';
  }
}

/**
 * Drives `fy render …` (docs/fy-render.md § Guide for agents).
 *
 * `guide` needs no daemon: the text ships in the binary, so an agent can learn a type's shape on a
 * machine whose daemon is stopped — the same property `fy config guide` has. The guide text is
 * injected rather than imported so a missing section is a testable refusal, not a crash mid-print.
 */
export class RenderController {
  constructor(
    private readonly out: IRenderOutput,
    private readonly bin: string,
    private readonly guide: string,
  ) {}

  /**
   * The overview plus one `render guide <type>` line per type, or one type's section. An unknown
   * type is refused with the list, because a guess would print the wrong shape silently.
   */
  guideFor(type: string | undefined): void {
    if (type === undefined) {
      const commands = RENDER_GUIDE_TYPES.map(each => `${this.bin} render guide ${each}`).join('\n');
      this.out.success(`${this.section('overview')}\n\n${commands}`);
      return;
    }
    const section = renderGuideSectionName(type);
    if (section === undefined) {
      throw new RenderCommandError(`no type ${type} — one of ${RENDER_GUIDE_TYPES.join(', ')}`);
    }
    this.out.success(this.section(section));
  }

  /** One section's body, refusing by name when the shipped guide has lost it. */
  private section(name: string): string {
    const body = renderGuideSection(this.guide, name);
    if (body === undefined || body === '') {
      throw new RenderCommandError(
        `the shipped guide has no ### ${name} section — docs/fy-render.md § Guide for agents and packages/cli/src/lib/render/guide-text.ts disagree`,
      );
    }
    return body;
  }
}
