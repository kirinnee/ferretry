/** The browser tools' bounds, copied from today's `protocol/src/lib/agent-tools.ts` (the terminal ones are Terminals'). */

/** The longest text one `terminal.send` or `browser.type` carries. */
export const AGENT_TOOL_MAX_TEXT_CHARS = 16_384;
/** The most text one read or wait hands back. The tail is kept: the newest output is what matters. */
export const AGENT_TOOL_MAX_OUTPUT_CHARS = 65_536;
/**
 * The longest one daemon-side wait may last, and its default. Under the HTTP server's own 30 s idle
 * timeout on purpose: a longer wait would be cut by the server and read as a failure. A client that
 * wants longer waits again — `fy` and the MCP server both loop up to {@link AGENT_TOOL_MAX_TOTAL_WAIT_MS}.
 */
export const AGENT_TOOL_MAX_WAIT_MS = 25_000;
export const AGENT_TOOL_DEFAULT_WAIT_MS = 10_000;
export const AGENT_TOOL_MAX_TOTAL_WAIT_MS = 120_000;
/** The longest URL an agent may navigate to. */
export const AGENT_TOOL_MAX_URL_CHARS = 2_048;
/** The longest selector an agent may click, type into or read. */
export const AGENT_TOOL_MAX_SELECTOR_CHARS = 1_024;
/** The longest script one `browser.eval` carries. */
export const AGENT_TOOL_MAX_SCRIPT_CHARS = 4_096;
/** The longest one `browser.eval` may run, and how long it runs when asked for no limit. */
export const AGENT_TOOL_MAX_SCRIPT_MS = 10_000;
export const AGENT_TOOL_DEFAULT_SCRIPT_MS = 5_000;
/** The longest folder a terminal may be opened in. */
/** The longest path an agent may name a file by (one to upload, or where to save one). */
export const AGENT_TOOL_MAX_PATH_CHARS = 1_024;
/** The most files one `browser.upload` carries. */
export const AGENT_TOOL_MAX_UPLOAD_FILES = 20;
/** The largest one file an upload may carry, and the most one call may carry in all. */
export const AGENT_TOOL_MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const AGENT_TOOL_MAX_UPLOAD_CALL_BYTES = 200 * 1024 * 1024;
/** The largest file a download or a PDF may be saved as. */
export const AGENT_TOOL_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** The longest sentence an agent may leave the owner when it hands a surface over. */
export const AGENT_TOOL_MAX_ASK_CHARS = 280;
