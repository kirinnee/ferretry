import { z } from 'zod';

export const NonEmptyStringSchema = z.string().trim().min(1);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeFiniteSchema = z.number().finite().nonnegative();

/** A lower-case kebab-case name: `board`, `claude-code`, `sign-in-approval`. */
export const KEBAB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const KebabNameSchema = z.string().regex(KEBAB_NAME);

/**
 * The name of an item in a configuration collection (a profile, a runtime, an MCP server, a skill, a settings or hooks
 * item): ASCII letters and digits in words joined by single dashes, case kept. It allows no slash, dot, space, control
 * character or look-alike of any of them, so a name can never be read as a path. This is the ONE copy: every collection
 * that names its items this way imports it, and none declares its own.
 */
export const ITEM_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;

const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A short span in words: "two minutes", "one minute", "90 seconds". */
export const durationWords = (secondsCount: number): string => {
  const wholeMinutes = secondsCount >= 60 && secondsCount % 60 === 0;
  const count = wholeMinutes ? secondsCount / 60 : secondsCount;
  return `${SMALL_NUMBER_WORDS[count] ?? String(count)} ${wholeMinutes ? 'minute' : 'second'}${count === 1 ? '' : 's'}`;
};

/** How many times, in words: "once", "twice", "3 times". */
export const timesWords = (count: number): string =>
  count === 1 ? 'once' : count === 2 ? 'twice' : `${String(count)} times`;
