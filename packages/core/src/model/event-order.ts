import type { ModelEvent } from './event.ts';

export type OrderRule =
  | 'terminal'
  | 'after-terminal'
  | 'interleaved'
  | 'unclosed-part'
  | 'duplicate-tool-id'
  | 'usage'
  | 'stop-reason';

export interface OrderViolation {
  readonly index: number;
  readonly rule: OrderRule;
  readonly detail: string;
}

type OpenPart = 'text' | 'reasoning' | undefined;

/**
 * Checks a complete stream against the ordering rules of docs/model-contract.md §3. Pure, so the
 * provider conformance suite and the agent loop's tests can share one definition:
 * - parts are sequential: `text_delta`* then one `text_done`; `reasoning_delta`* then one
 *   `reasoning_done`; a tool call is one event; nothing interleaves;
 * - tool call ids are unique across `tool_call` and `tool_call_invalid`;
 * - `usage` appears at most once, immediately before the terminal event;
 * - exactly one terminal event (`done` | `error`) ends the stream, with nothing after it;
 * - `tool_use` needs at least one tool event, and a `truncated` call ends with `max_tokens`.
 * A part may be cut short by an `error` terminal (the loop discards it), but not by `done`.
 * Usage normalization (rule 2a) is adapter behavior and cannot be checked from events alone.
 */
export function checkModelEventOrder(events: readonly ModelEvent[]): OrderViolation[] {
  const violations: OrderViolation[] = [];
  const add = (index: number, rule: OrderRule, detail: string): void => {
    violations.push({ index, rule, detail });
  };
  let open: OpenPart;
  let terminalIndex: number | undefined;
  let usageCount = 0;
  let toolEvents = 0;
  let sawTruncated = false;
  const toolIds = new Set<string>();

  events.forEach((event, index) => {
    if (terminalIndex !== undefined) {
      add(
        index,
        'after-terminal',
        `${event.type} after the terminal event at ${String(terminalIndex)}`,
      );
      return;
    }
    switch (event.type) {
      case 'text_delta':
        if (open === 'reasoning') {
          add(index, 'interleaved', 'text_delta inside an open reasoning part');
        }
        open = 'text';
        break;
      case 'text_done':
        if (open === 'reasoning') {
          add(index, 'interleaved', 'text_done closes a reasoning part');
        }
        open = undefined;
        break;
      case 'reasoning_delta':
        if (open === 'text') {
          add(index, 'interleaved', 'reasoning_delta inside an open text part');
        }
        open = 'reasoning';
        break;
      case 'reasoning_done':
        if (open === 'text') {
          add(index, 'interleaved', 'reasoning_done closes a text part');
        }
        open = undefined;
        break;
      case 'tool_call':
      case 'tool_call_invalid':
        if (open !== undefined) {
          add(index, 'interleaved', `${event.type} inside an open ${open} part`);
        }
        toolEvents += 1;
        if (toolIds.has(event.id)) {
          add(index, 'duplicate-tool-id', `tool call id ${event.id} was already used`);
        }
        toolIds.add(event.id);
        if (event.type === 'tool_call_invalid' && event.reason === 'truncated') {
          sawTruncated = true;
        }
        break;
      case 'usage': {
        usageCount += 1;
        if (usageCount > 1) {
          add(index, 'usage', 'usage must appear at most once');
        }
        const next = events[index + 1];
        if (next?.type !== 'done' && next?.type !== 'error') {
          add(index, 'usage', 'usage must be immediately before the terminal event');
        }
        break;
      }
      case 'done':
        terminalIndex = index;
        if (open !== undefined) {
          add(index, 'unclosed-part', `done while a ${open} part is still open`);
        }
        if (event.stopReason === 'tool_use' && toolEvents === 0) {
          add(index, 'stop-reason', 'tool_use without any tool_call or tool_call_invalid');
        }
        if (sawTruncated && event.stopReason !== 'max_tokens') {
          add(index, 'stop-reason', 'a truncated tool call must end with max_tokens');
        }
        break;
      case 'error':
        terminalIndex = index;
        break;
    }
  });

  if (terminalIndex === undefined) {
    add(events.length, 'terminal', 'the stream has no terminal done or error event');
  }
  return violations;
}
