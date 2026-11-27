/** Worker-private masks. No getter: a value can only be remembered or scrubbed out of an answer. */
export class CaptureValues {
  private readonly values = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly native = new Map<string, string>();
  private readonly durable = new Set<string>();
  private bytes = 0;
  private failed = false;
  private matcher: RegExp | undefined;
  private marker = '[redacted]';

  remember(value: string): void {
    if (!value || this.observed.has(value)) return;
    for (const variant of this.variants(value)) this.durable.add(variant);
    this.observed.add(value);
    this.refresh();
  }

  /** One last nonempty value per native field, never a history of typing prefixes. */
  observe(key: string, value: string): void {
    if (!value || this.native.get(key) === value) return;
    if (!this.native.has(key) && this.native.size >= 4096) {
      this.failed = true;
      throw new Error('browser native capture masks are full; restart this browser');
    }
    this.native.set(key, value);
    this.refresh();
  }

  private variants(value: string): Set<string> {
    const bases = [value, value.replace(/\r\n?/gu, '\n'), value.replace(/[\r\n]/gu, '')];
    const variants = new Set(
      bases.flatMap(text => [
        text,
        text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
      ]),
    );
    for (const variant of [...variants])
      try {
        variants.add(encodeURI(variant));
        variants.add(encodeURIComponent(variant));
        variants.add(new URLSearchParams({ value: variant }).toString().slice(6));
      } catch {
        /* Lone surrogates still have literal/JSON masks. */
      }
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1));
    return variants;
  }

  private refresh(): void {
    this.values.clear();
    this.bytes = 0;
    const variants = new Set(this.durable);
    for (const value of this.native.values())
      if (value.length >= 6) for (const variant of this.variants(value)) variants.add(variant);
    for (const variant of variants) {
      if (!variant || this.values.has(variant)) continue;
      this.bytes += variant.length;
      if (this.values.size >= 4096 || this.bytes > 2_097_152) {
        this.failed = true;
        throw new Error('browser capture masks are full; close this browser before capturing again');
      }
      this.values.add(variant);
    }
    const marker = ['[redacted]', '█', '■', '●', '□', '◆'].find(marker =>
      [...this.values].every(value => !marker.includes(value)),
    );
    if (!marker) {
      this.failed = true;
      throw new Error('browser capture cannot choose a safe mask; restart this browser');
    }
    this.marker = marker;
    this.matcher = undefined;
  }

  text(text: string): string {
    if (this.failed) throw new Error('browser capture masks are unavailable');
    if (this.values.size === 0) return text;
    this.matcher ??= new RegExp(
      [...this.values]
        .sort((a, b) => b.length - a.length)
        .map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('|'),
      'gu',
    );
    // Only literal alternatives, longest first; replacements are never matched again by shorter values.
    return text.replace(this.matcher, this.marker);
  }

  data(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.data(item));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === 'url' && typeof item === 'string' ? this.url(item) : PRIVATE_FIELDS.has(key) ? item : this.data(item),
        ]),
      );
    return value;
  }

  queryAllowed(text: string): boolean {
    return this.text(text) === text && !text.includes(this.marker);
  }

  url(text: string): string {
    const masked = this.text(text);
    try {
      new URL(masked);
      return masked;
    } catch {
      return 'about:blank';
    }
  }
}

/** Opaque routing, filesystem and origin facts stay private to the daemon and must not be changed by a display mask. */
const PRIVATE_FIELDS = new Set([
  'id',
  'activePageId',
  'actedPageId',
  'openerId',
  'downloadId',
  'path',
  'scriptOrigin',
  'pageState',
  'state',
  'type',
  'screenshotFormat',
  'dialogType',
  'screenshotBase64',
  'pngBase64',
  'origin',
  'frameOrigin',
  'provider',
  'identifierHost',
  'identifierFields',
]);
