import { describe, expect, it } from 'vitest';
import * as publicApi from './index.ts';

describe('@autogeek/workspace', () => {
  it('exposes exactly the documented public surface', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'classifyPath',
      'isExecVector',
      'resolveLexically',
    ]);
  });
});
