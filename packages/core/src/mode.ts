import { z } from 'zod';

/** The agent's operating mode; each mode has its own tool allowlist enforced by the loop. */
export const AgentModeSchema = z.enum(['ask', 'plan', 'agent']);
export type AgentMode = z.infer<typeof AgentModeSchema>;
