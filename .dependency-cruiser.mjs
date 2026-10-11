import { CRUISE_OPTIONS, createDependencyRuleSet } from './tooling/src/dependency-rules.ts';

export default { ...createDependencyRuleSet(), options: CRUISE_OPTIONS };
