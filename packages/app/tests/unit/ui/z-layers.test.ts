import { describe, expect, test } from 'bun:test';

/**
 * THE APP'S ONE Z-INDEX SCALE for what draws above the page: sheets and an item's own overlay at z-40, an anchored popover
 * (`--z-popover`, declared once in `styles/shell.css`) above them, every dialog and its scrim (the command bar, a context
 * menu, the machine chooser, the image viewer) at z-50. A popover over a dialog's scrim would stay clickable above it.
 */
const read = async (relative: string): Promise<string> => await Bun.file(new URL(relative, import.meta.url)).text();

describe('the layers a popover sits between', () => {
  test('--z-popover is declared once, above sheets (z-40) and below dialogs (z-50)', async () => {
    const css = await read('../../../src/styles/shell.css');
    const declared = [...css.matchAll(/--z-popover:\s*(\d+)/gu)];
    expect(declared).toHaveLength(1);
    const layer = Number(declared[0]?.[1]);
    expect(layer).toBeGreaterThan(40);
    expect(layer).toBeLessThan(50);
  });

  test('the command bar, the context menu and the image viewer stay on the dialog layer, above it', async () => {
    for (const file of ['command-bar.tsx', 'context-menu.tsx', 'image-viewer.tsx'])
      expect(await read(`../../../src/ui/${file}`), file).toContain('z-50');
  });
});
