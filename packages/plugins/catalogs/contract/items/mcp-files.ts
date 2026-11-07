export interface McpProjectFileReading {
  readonly text: string | null;
  readonly etag: string | null;
}

export class McpProjectFileChanged extends Error {
  constructor() {
    super('.mcp.json changed since the preview. Review the new diff, then add the server again.');
    this.name = 'McpProjectFileChanged';
  }
}

export interface McpProjectFiles {
  read(path: string): Promise<McpProjectFileReading>;
  /**
   * Replace the file with `text` only while it still reads as `expected` (null: still absent), keeping
   * its mode. Throws {@link McpProjectFileChanged} otherwise. Answers the new etag.
   */
  replace(path: string, text: string, expected: string | null): Promise<string>;
}
