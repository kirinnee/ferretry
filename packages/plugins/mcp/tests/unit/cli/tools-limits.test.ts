import { describe, it } from 'bun:test';
import should from 'should';
import { INPUT_MAX_EXPIRY_SECONDS, INPUT_PROMPT_MAX_LENGTH } from '../../../../../core/vault/contract/inputs.ts';
import { INPUT_MAX_FIELDS } from '../../../../../core/vault/contract/targets.ts';
import { LOGIN_RECIPE_MAX_LENGTH } from '../../../../accounts/contract/routes/login-recipes.ts';
import {
  BROWSER_CONSOLE_LEVELS,
  BROWSER_CPU_THROTTLE_MAX,
  BROWSER_EMULATED_PERMISSIONS,
  BROWSER_RESOURCE_TYPES,
} from '../../../../browsers/contract/wire/page-lifecycle.ts';
import { LESSON_RULE_MAX_CHARS } from '../../../../lessons/contract/suggest.ts';
import {
  AGENT_TOOL_DEFAULT_WAIT_MS,
  AGENT_TOOL_MAX_READ_LINES,
  AGENT_TOOL_MAX_WAIT_MS,
  TERMINAL_KEYS,
} from '../../../../terminals/contract/wire.ts';
import { AGENT_TOOL_MAX_TOTAL_WAIT_MS, MCP_TOOLS } from '../../../cli/lib/serve/tools.ts';

/**
 * The hand-written schemas carry each owner's limits as literals (the mcp manifest does not consume those contracts, so
 * its cli half may not import them). This test is where the numbers meet their owners: a limit that moved fails here.
 */
const property = (tool: string, name: string): Record<string, unknown> => {
  const found = MCP_TOOLS.find(candidate => candidate.name === tool);
  const properties = found?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  const one = properties?.[name];
  if (one === undefined) throw new Error(`${tool} lists no ${name}`);
  return one;
};

describe('the tool schemas’ limits', () => {
  it('should carry the terminals contract’s keys, line limit and wait limits', () => {
    should((property('terminal_send', 'keys').items as { enum: string[] }).enum).eql([...TERMINAL_KEYS]);
    should(property('terminal_read', 'lines').maximum).equal(AGENT_TOOL_MAX_READ_LINES);
    should(property('input_wait', 'timeoutMs').maximum).equal(AGENT_TOOL_MAX_WAIT_MS);
    should(property('terminal_wait', 'timeoutMs').description).containEql(String(AGENT_TOOL_DEFAULT_WAIT_MS));
    should(property('terminal_wait', 'timeoutMs').maximum).equal(AGENT_TOOL_MAX_TOTAL_WAIT_MS);
    should(AGENT_TOOL_MAX_TOTAL_WAIT_MS).equal(120_000);
  });

  it('should carry the browsers contract’s enums and limits', () => {
    should(property('browser_console', 'level').enum).eql([...BROWSER_CONSOLE_LEVELS]);
    should((property('browser_network', 'types').items as { enum: string[] }).enum).eql([...BROWSER_RESOURCE_TYPES]);
    should((property('browser_emulate', 'permissions').items as { enum: string[] }).enum).eql([
      ...BROWSER_EMULATED_PERMISSIONS,
    ]);
    should(property('browser_emulate', 'cpuThrottle').maximum).equal(BROWSER_CPU_THROTTLE_MAX);
    should(property('browser_wait_for', 'time').maximum).equal(AGENT_TOOL_MAX_WAIT_MS);
  });

  it('should carry Vault’s input limits, Lessons’ rule limit and Accounts’ recipe limit', () => {
    should(property('terminal_request_input', 'prompt').maxLength).equal(INPUT_PROMPT_MAX_LENGTH);
    should(property('terminal_request_input', 'expiresInSeconds').maximum).equal(INPUT_MAX_EXPIRY_SECONDS);
    should(property('browser_request_input', 'fields').maxItems).equal(INPUT_MAX_FIELDS);
    should(property('lessons_suggest', 'rule').maxLength).equal(LESSON_RULE_MAX_CHARS);
    // Accounts' propose tool is not listed (not built), but its literal is pinned the day it is.
    should(LOGIN_RECIPE_MAX_LENGTH).equal(4_000);
  });
});
