import type { IRenderOutput } from '../../../src/lib/render/ports';

/** Records what `fy render` printed, and never touches a console. */
export class FakeRenderOutput implements IRenderOutput {
  text = '';

  success(message: string): void {
    this.text = message;
  }
}
