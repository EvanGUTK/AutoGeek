import type { Message } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import {
  inProgressToolTurn,
  messageText,
  splitSystemPrompt,
  systemInstructionEnvelope,
} from './shared.ts';

const text = (role: Message['role'], value: string): Message => ({
  role,
  content: [{ type: 'text', text: value }],
});
const call: Message = {
  role: 'assistant',
  content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }],
};
const result: Message = {
  role: 'tool',
  content: [{ type: 'tool_result', callId: 'c', output: 'ok', isError: false }],
};

describe('splitSystemPrompt', () => {
  it('takes only the leading run of system messages', () => {
    const messages = [text('system', 'a'), text('user', 'u'), text('system', 'mid')];
    const { system, rest } = splitSystemPrompt(messages);
    expect(system).toEqual([messages[0]]);
    expect(rest).toEqual(messages.slice(1));
  });

  it('handles all-system and no-system input', () => {
    expect(splitSystemPrompt([text('system', 'a')]).rest).toEqual([]);
    expect(splitSystemPrompt([text('user', 'u')]).system).toEqual([]);
  });
});

describe('messageText', () => {
  it('joins non-empty text parts', () => {
    const message: Message = {
      role: 'system',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: '' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'AA==' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(messageText(message)).toBe('a\n\nb');
  });
});

describe('systemInstructionEnvelope', () => {
  it('wraps the text in the fixed envelope', () => {
    expect(systemInstructionEnvelope('x')).toBe('<system-instruction>\nx\n</system-instruction>');
  });
});

describe('inProgressToolTurn', () => {
  it('finds the last assistant tool turn when only results and system messages follow', () => {
    expect(inProgressToolTurn([text('user', 'q'), call, result, text('system', 's')])).toBe(1);
    expect(inProgressToolTurn([text('user', 'q'), call])).toBe(1);
  });

  it('is undefined once a user turn follows or the last assistant turn has no call', () => {
    expect(
      inProgressToolTurn([text('user', 'q'), call, result, text('user', 'more')]),
    ).toBeUndefined();
    expect(inProgressToolTurn([text('user', 'q'), text('assistant', 'a')])).toBeUndefined();
    expect(inProgressToolTurn([text('user', 'q')])).toBeUndefined();
  });
});
