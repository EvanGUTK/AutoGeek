import { describe, expect, it } from 'vitest';
import * as publicApi from './index.ts';

describe('@autogeek/providers', () => {
  it('exposes exactly the intended runtime surface', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'DEFAULT_RETRY_POLICY',
      'DEFAULT_TIMEOUTS',
      'NOOP_LOGGER',
      'createAnthropicProvider',
      'createTransportDeps',
    ]);
  });
});
