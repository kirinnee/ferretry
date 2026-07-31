#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

type SayStep = Readonly<{
  type: 'say';
  text: string;
}>;

type AskStep = Readonly<{
  type: 'ask';
  text: string;
  expect: string;
}>;

type WriteStep = Readonly<{
  type: 'write';
  stream: 'stdout' | 'stderr';
  text: string;
}>;

type ExitStep = Readonly<{
  type: 'exit';
  code: number;
}>;

type ScenarioStep = SayStep | AskStep | WriteStep | ExitStep;

type Scenario = Readonly<{
  version: 1;
  steps: readonly ScenarioStep[];
}>;

class HarnessError extends Error {}

function requireAbsolutePath(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new HarnessError(`${name} is required`);
  }
  if (!isAbsolute(value)) {
    throw new HarnessError(`${name} must be an absolute path`);
  }
  return value;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HarnessError(`${context} has unknown or missing fields`);
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new HarnessError(`${context} must be a string`);
  }
  return value;
}

function parseStep(value: unknown, index: number, finalIndex: number): ScenarioStep {
  const context = `steps[${index}]`;
  const record = requireRecord(value, context);

  switch (record.type) {
    case 'say':
      requireExactKeys(record, ['type', 'text'], context);
      return { type: 'say', text: requireString(record.text, `${context}.text`) };
    case 'ask': {
      requireExactKeys(record, ['type', 'text', 'expect'], context);
      const expectedInput = requireString(record.expect, `${context}.expect`);
      if (expectedInput.includes('\n') || expectedInput.includes('\r')) {
        throw new HarnessError(`${context}.expect must contain exactly one input line`);
      }
      return {
        type: 'ask',
        text: requireString(record.text, `${context}.text`),
        expect: expectedInput,
      };
    }
    case 'write': {
      requireExactKeys(record, ['type', 'stream', 'text'], context);
      if (record.stream !== 'stdout' && record.stream !== 'stderr') {
        throw new HarnessError(`${context}.stream must be stdout or stderr`);
      }
      return {
        type: 'write',
        stream: record.stream,
        text: requireString(record.text, `${context}.text`),
      };
    }
    case 'exit': {
      requireExactKeys(record, ['type', 'code'], context);
      if (typeof record.code !== 'number' || !Number.isInteger(record.code) || record.code < 0 || record.code > 255) {
        throw new HarnessError(`${context}.code must be an integer from 0 through 255`);
      }
      if (index !== finalIndex) {
        throw new HarnessError(`${context} must be the final step`);
      }
      return { type: 'exit', code: record.code };
    }
    default:
      throw new HarnessError(`${context}.type is unsupported`);
  }
}

function parseScenario(value: unknown): Scenario {
  const record = requireRecord(value, 'scenario');
  requireExactKeys(record, ['version', 'steps'], 'scenario');
  if (record.version !== 1) {
    throw new HarnessError('scenario.version must equal 1');
  }
  if (!Array.isArray(record.steps)) {
    throw new HarnessError('scenario.steps must be an array');
  }

  const finalIndex = record.steps.length - 1;
  return {
    version: 1,
    steps: record.steps.map((step, index) => parseStep(step, index, finalIndex)),
  };
}

async function writeExactly(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

let lineReader: Interface | undefined;
let lineIterator: AsyncIterator<string> | undefined;

async function readInputLine(stepIndex: number): Promise<string> {
  if (lineReader === undefined || lineIterator === undefined) {
    lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    lineIterator = lineReader[Symbol.asyncIterator]();
  }

  const next = await lineIterator.next();
  if (next.done) {
    throw new HarnessError(`stdin ended before steps[${stepIndex}] received a line`);
  }
  return next.value;
}

async function main(): Promise<void> {
  const scenarioPath = requireAbsolutePath('FY_E2E_HARNESS_SCRIPT');
  const invocationsPath = requireAbsolutePath('FY_E2E_HARNESS_INVOCATIONS');
  const invocation = {
    argv: Bun.argv.slice(2),
    cwd: process.cwd(),
    wrapper: basename(Bun.argv[1] ?? 'fake-harness'),
  };

  try {
    await appendFile(invocationsPath, `${JSON.stringify(invocation)}\n`, { encoding: 'utf8' });
  } catch {
    throw new HarnessError('could not append the invocation log');
  }

  let source: string;
  try {
    source = await Bun.file(scenarioPath).text();
  } catch {
    throw new HarnessError('could not read the scenario file');
  }

  let rawScenario: unknown;
  try {
    rawScenario = JSON.parse(source) as unknown;
  } catch {
    throw new HarnessError('scenario file is not valid JSON');
  }

  const scenario = parseScenario(rawScenario);
  let exitCode = 0;

  for (const [index, step] of scenario.steps.entries()) {
    switch (step.type) {
      case 'say':
        await writeExactly(process.stdout, `${step.text}\n`);
        break;
      case 'ask': {
        await writeExactly(process.stdout, `${step.text}\n`);
        const input = await readInputLine(index);
        if (input !== step.expect) {
          throw new HarnessError(`stdin did not match steps[${index}].expect`);
        }
        break;
      }
      case 'write':
        await writeExactly(step.stream === 'stdout' ? process.stdout : process.stderr, step.text);
        break;
      case 'exit':
        exitCode = step.code;
        break;
    }
  }

  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  const message = error instanceof HarnessError ? error.message : 'unexpected failure';
  try {
    await writeExactly(process.stderr, `fake-harness: ${message}\n`);
  } catch {
    // The original failure remains authoritative when stderr is unavailable.
  }
  process.exitCode = 1;
} finally {
  lineReader?.close();
}
