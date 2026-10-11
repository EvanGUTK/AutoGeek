// Public surface of @autogeek/workspace.
export { classifyPath, isExecVector } from './path-security/classifier.ts';
export type { PathClassification, PathOp } from './path-security/classifier.ts';
export type { PathAccess, PathCategory } from './path-security/rules.ts';
export { resolveLexically } from './path-security/lexical.ts';
export type {
  LexicalErrorCode,
  LexicalOptions,
  LexicalPlatform,
  LexicalResult,
  LexicalValue,
} from './path-security/lexical.ts';
