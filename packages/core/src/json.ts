import { z } from 'zod';

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object (never an array or primitive). */
export type JsonObject = Record<string, JsonValue>;

/** Deepest container nesting accepted (a primitive is depth 0, each array or object adds 1). */
export const JSON_MAX_DEPTH = 64;
/** Most values (every primitive, array and object counts as one) accepted in one document. */
export const JSON_MAX_NODES = 100_000;

const MESSAGES = {
  notJson: 'The value is not JSON-serializable.',
  notObject: 'The value is not a JSON object.',
  tooDeep: `The JSON value is nested deeper than ${String(JSON_MAX_DEPTH)} levels.`,
  tooManyNodes: `The JSON value has more than ${String(JSON_MAX_NODES)} nodes.`,
} as const;

interface Frame {
  readonly value: unknown;
  readonly depth: number;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Walks `root` iteratively (an explicit stack, no recursion) and returns the first problem, or
 * undefined when it is a JSON value within the depth and node limits. Recursive validation
 * throws RangeError on deeply nested input, which at every untrusted boundary (tool input, MCP,
 * IPC details) would be a crash instead of a validation failure. Cycles and shared structures
 * are bounded by the same limits: a cycle exceeds the depth, and a heavily shared DAG exceeds the
 * node count, both quickly. Messages never include the rejected value.
 */
function findJsonProblem(root: unknown, mustBeObject: boolean): string | undefined {
  if (
    mustBeObject &&
    (typeof root !== 'object' || root === null || Array.isArray(root) || !isPlainObject(root))
  ) {
    return MESSAGES.notObject;
  }
  const stack: Frame[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value, depth } = frame;
    nodes += 1;
    if (nodes > JSON_MAX_NODES) {
      return MESSAGES.tooManyNodes;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return MESSAGES.notJson;
      }
      continue;
    }
    if (typeof value !== 'object') {
      return MESSAGES.notJson;
    }
    if (depth + 1 > JSON_MAX_DEPTH) {
      return MESSAGES.tooDeep;
    }
    if (Array.isArray(value)) {
      // Bound the length BEFORE iterating, so a huge (sparse) array is never walked or pushed.
      if (nodes + value.length > JSON_MAX_NODES) {
        return MESSAGES.tooManyNodes;
      }
      // Read own data properties through their descriptors: a getter could return a different
      // value after validation, and a hole has no descriptor. Neither is JSON.
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !('value' in descriptor)) {
          return MESSAGES.notJson;
        }
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(value)) {
      return MESSAGES.notJson;
    }
    const keys = Object.keys(value);
    if (nodes + keys.length > JSON_MAX_NODES) {
      return MESSAGES.tooManyNodes;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        return MESSAGES.notJson; // an accessor: it could return something else later
      }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  return undefined;
}

function boundedJson<T>(mustBeObject: boolean): z.ZodCustom<T, T> {
  return z.custom<T>().superRefine((value, context) => {
    const problem = findJsonProblem(value, mustBeObject);
    if (problem !== undefined) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });
}

export const JsonValueSchema = boundedJson<JsonValue>(false);

export const JsonObjectSchema = boundedJson<JsonObject>(true);
