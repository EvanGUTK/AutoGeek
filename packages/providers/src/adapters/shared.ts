import type { Message } from '@autogeek/core';

/**
 * How a mid-conversation `system` message reaches a vendor without a native form: a user turn in
 * this fixed envelope. Lossy (the model sees it as user text) and documented in
 * docs/model-contract.md section 1.
 */
export function systemInstructionEnvelope(text: string): string {
  return `<system-instruction>\n${text}\n</system-instruction>`;
}

/** The leading run of `system` messages (the system prompt) and everything after it. */
export function splitSystemPrompt(messages: readonly Message[]): {
  readonly system: readonly Message[];
  readonly rest: readonly Message[];
} {
  const first = messages.findIndex((message) => message.role !== 'system');
  if (first === -1) return { system: messages, rest: [] };
  return { system: messages.slice(0, first), rest: messages.slice(first) };
}

/** Concatenated text parts of a message. */
export function messageText(message: Message): string {
  return message.content
    .flatMap((part) => (part.type === 'text' && part.text !== '' ? [part.text] : []))
    .join('\n\n');
}

/**
 * Index (in `messages`) of the in-progress tool-use turn: the last assistant message, when it
 * contains a tool call and only tool results or system messages follow it. Vendors require that
 * turn's reasoning to be replayed even when reasoning is otherwise dropped.
 */
export function inProgressToolTurn(messages: readonly Message[]): number | undefined {
  let last = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant') last = index;
  });
  const turn = messages[last];
  if (turn === undefined) return undefined;
  if (!turn.content.some((part) => part.type === 'tool_call')) return undefined;
  const after = messages.slice(last + 1);
  return after.every((message) => message.role === 'tool' || message.role === 'system')
    ? last
    : undefined;
}
