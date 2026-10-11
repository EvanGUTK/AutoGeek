/** What every redacted value or fragment becomes. */
export const REDACTED = '[REDACTED]';

/**
 * The exact secrets currently loaded in this process (API keys, access and refresh tokens). The
 * vault adds a secret when it decrypts one and removes it when the credential is deleted, so logs
 * are redacted even for keys whose shape no pattern knows (for example a local server's token).
 * Adds are counted, so two credentials sharing a value stay redacted until both are removed.
 */
export interface SecretRegistry {
  add(secret: string): void;
  remove(secret: string): void;
  /** Registered secrets, longest first, so a secret containing another is redacted whole. */
  secrets(): readonly string[];
}

export function createSecretRegistry(): SecretRegistry {
  const counts = new Map<string, number>();
  let sorted: readonly string[] = [];
  const resort = (): void => {
    sorted = [...counts.keys()].sort((a, b) => b.length - a.length);
  };
  return {
    add(secret) {
      if (secret.length === 0) return;
      counts.set(secret, (counts.get(secret) ?? 0) + 1);
      resort();
    },
    remove(secret) {
      const count = counts.get(secret);
      if (count === undefined) return;
      if (count > 1) counts.set(secret, count - 1);
      else counts.delete(secret);
      resort();
    },
    secrets: () => sorted,
  };
}

/** Header and field names whose value is a credential, written as `name: value` or `name=value`. */
const SENSITIVE_PAIR =
  /(\b(?:x-api-key|x-goog-api-key|api[_-]?key|access_token|refresh_token|id_token|client_secret|code_verifier|password|token)\b["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi;

const AUTHORIZATION =
  /(\bauthorization\b["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|token)\s+)?)([^\s"',;]+)/gi;

const BEARER = /(\bBearer\s+)([^\s"',;]+)/g;

/** Known key and token shapes, most specific first. */
const SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-(?:proj|svcacct|admin|or-v1)-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z_-]{20,}/g,
  /\b1\/\/[0-9A-Za-z_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * Redacts every registered secret, every value of a credential-bearing header or field, and every
 * substring with a known key or token shape. Errs towards over-redaction.
 */
export function redactText(text: string, registry: Pick<SecretRegistry, 'secrets'>): string {
  let out = text;
  for (const secret of registry.secrets()) {
    out = out.split(secret).join(REDACTED);
  }
  out = out.replace(AUTHORIZATION, `$1${REDACTED}`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(SENSITIVE_PAIR, `$1${REDACTED}`);
  for (const shape of SHAPES) {
    out = out.replace(shape, REDACTED);
  }
  return out;
}

/** Field names (case, `-` and `_` ignored) whose whole value is replaced, whatever it looks like. */
const SENSITIVE_FIELDS = new Set([
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'xapikey',
  'xgoogapikey',
  'key',
  'authorization',
  'cookie',
  'setcookie',
  'privatekey',
  'codeverifier',
]);

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELDS.has(name.toLowerCase().replace(/[-_]/g, ''));
}

const MAX_DEPTH = 8;

/** A JSON-safe value: what a redacted structure is made of. */
export type Redacted =
  string | number | boolean | null | readonly Redacted[] | { readonly [key: string]: Redacted };

function redactObject(
  entries: readonly (readonly [string, unknown])[],
  registry: Pick<SecretRegistry, 'secrets'>,
  ancestors: WeakSet<object>,
  depth: number,
): Redacted {
  const out: Record<string, Redacted> = {};
  for (const [name, value] of entries) {
    out[name] = isSensitiveField(name) ? REDACTED : walk(value, registry, ancestors, depth + 1);
  }
  return out;
}

function walk(
  value: unknown,
  registry: Pick<SecretRegistry, 'secrets'>,
  ancestors: WeakSet<object>,
  depth: number,
): Redacted {
  switch (typeof value) {
    case 'string':
      return redactText(value, registry);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return null;
    case 'symbol':
      return '[symbol]';
    case 'function':
      return '[function]';
    case 'object':
      break;
  }
  if (value === null) return null;
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  const out = walkObject(value, registry, ancestors, depth);
  ancestors.delete(value);
  return out;
}

function walkObject(
  value: object,
  registry: Pick<SecretRegistry, 'secrets'>,
  ancestors: WeakSet<object>,
  depth: number,
): Redacted {
  if (value instanceof Uint8Array) return `[binary ${String(value.length)} bytes]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Map) return `[map ${String(value.size)} entries]`;
  if (value instanceof Set) return `[set ${String(value.size)} entries]`;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, registry, ancestors, depth + 1));
  }
  if (value instanceof Error) {
    return redactObject(
      [
        ['name', value.name],
        ['message', value.message],
        ['stack', value.stack],
        ['cause', value.cause],
      ],
      registry,
      ancestors,
      depth,
    );
  }
  return redactObject(Object.entries(value), registry, ancestors, depth);
}

/**
 * Deep-redacts `value` into a JSON-safe structure: strings through `redactText`, sensitive field
 * names replaced whole, binary never emitted, errors reduced to name/message/stack/cause. Cycles
 * and excessive depth are summarized, never thrown on.
 */
export function redactValue(value: unknown, registry: Pick<SecretRegistry, 'secrets'>): Redacted {
  return walk(value, registry, new WeakSet(), 0);
}
