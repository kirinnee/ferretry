import type { Page } from 'playwright-core';
import type { CaptureRect } from './fields.ts';

/** A private, unroutable compositor page. It receives pixels and rectangles, never any field value. */
export class CapturePixels {
  private page: Promise<Page> | undefined;
  constructor(private readonly makePage: () => Promise<Page>) {}

  async paint(
    base64: string,
    format: 'png' | 'jpeg',
    rects: readonly CaptureRect[],
    clip: CaptureRect,
  ): Promise<string> {
    if (rects.length === 0) return base64;
    this.page ??= this.makePage();
    const page = await this.page;
    return await page.evaluate(
      async ({ base64, format, rects, clip }) => {
        const image = new Image();
        image.src = `data:image/${format};base64,${base64}`;
        await image.decode();
        if (image.width * image.height > 32_000_000 || clip.w <= 0 || clip.h <= 0)
          throw new Error('capture exceeds the pixel mask limit');
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('pixel masks are unavailable');
        context.drawImage(image, 0, 0);
        context.fillStyle = '#000';
        const sx = image.width / clip.w;
        const sy = image.height / clip.h;
        for (const rect of rects) {
          // Grow outwards before rasterising, so scaling and JPEG borders never expose an edge glyph.
          const x = Math.floor((rect.x - clip.x - 2) * sx);
          const y = Math.floor((rect.y - clip.y - 2) * sy);
          const right = Math.ceil((rect.x + rect.w - clip.x + 2) * sx);
          const bottom = Math.ceil((rect.y + rect.h - clip.y + 2) * sy);
          context.fillRect(x, y, right - x, bottom - y);
        }
        const encoded = canvas.toDataURL(`image/${format}`, 0.85).split(',')[1];
        if (!encoded) throw new Error('the masked capture could not be encoded');
        return encoded;
      },
      { base64, format, rects, clip },
    );
  }
}
