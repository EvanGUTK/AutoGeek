import { describe, expect, it } from 'vitest';
import { createEmitter } from './emitter.ts';

interface Events {
  greeting: { name: string };
  count: number;
}

interface ReportedError {
  readonly error: unknown;
  readonly type: string;
}

function setup(): { emitter: ReturnType<typeof createEmitter<Events>>; reported: ReportedError[] } {
  const reported: ReportedError[] = [];
  const emitter = createEmitter<Events>({
    onListenerError: (error, type) => reported.push({ error, type }),
  });
  return { emitter, reported };
}

describe('createEmitter', () => {
  it('delivers payloads to listeners in registration order', () => {
    const { emitter } = setup();
    const seen: string[] = [];
    emitter.on('greeting', (p) => seen.push(`a:${p.name}`));
    emitter.on('greeting', (p) => seen.push(`b:${p.name}`));
    emitter.emit('greeting', { name: 'x' });
    expect(seen).toEqual(['a:x', 'b:x']);
  });

  it('keeps event types isolated from each other', () => {
    const { emitter } = setup();
    const counts: number[] = [];
    emitter.on('count', (n) => counts.push(n));
    emitter.emit('greeting', { name: 'x' });
    emitter.emit('count', 3);
    expect(counts).toEqual([3]);
  });

  it('stops delivering after unsubscribe, and unsubscribe is idempotent', () => {
    const { emitter } = setup();
    const seen: number[] = [];
    const off = emitter.on('count', (n) => seen.push(n));
    emitter.emit('count', 1);
    off();
    off();
    emitter.emit('count', 2);
    expect(seen).toEqual([1]);
    expect(emitter.listenerCount('count')).toBe(0);
  });

  it('removes the listener when its signal aborts', () => {
    const { emitter } = setup();
    const controller = new AbortController();
    const seen: number[] = [];
    emitter.on('count', (n) => seen.push(n), { signal: controller.signal });
    emitter.emit('count', 1);
    controller.abort();
    emitter.emit('count', 2);
    expect(seen).toEqual([1]);
    expect(emitter.listenerCount('count')).toBe(0);
  });

  it('never registers a listener whose signal is already aborted', () => {
    const { emitter } = setup();
    const seen: number[] = [];
    emitter.on('count', (n) => seen.push(n), { signal: AbortSignal.abort() });
    emitter.emit('count', 1);
    expect(seen).toEqual([]);
    expect(emitter.listenerCount('count')).toBe(0);
  });

  it('does not call a listener added during an emit for that same emit', () => {
    const { emitter } = setup();
    const late: number[] = [];
    emitter.on('count', () => {
      emitter.on('count', (n) => late.push(n));
    });
    emitter.emit('count', 1);
    expect(late).toEqual([]);
    emitter.emit('count', 2);
    expect(late).toEqual([2]);
  });

  it('does not call a listener that was unsubscribed earlier in the same emit', () => {
    const { emitter } = setup();
    const seen: string[] = [];
    const offSecond = { off: (): void => undefined };
    emitter.on('count', () => {
      seen.push('first');
      offSecond.off();
    });
    offSecond.off = emitter.on('count', () => seen.push('second'));
    emitter.emit('count', 1);
    expect(seen).toEqual(['first']);
  });

  it('reports a throwing listener and still runs the others', () => {
    const { emitter, reported } = setup();
    const seen: number[] = [];
    const boom = new Error('boom');
    emitter.on('count', () => {
      throw boom;
    });
    emitter.on('count', (n) => seen.push(n));
    expect(() => {
      emitter.emit('count', 5);
    }).not.toThrow();
    expect(seen).toEqual([5]);
    expect(reported).toEqual([{ error: boom, type: 'count' }]);
  });

  it('emitting with no listeners is a no-op', () => {
    const { emitter } = setup();
    expect(() => {
      emitter.emit('count', 1);
    }).not.toThrow();
  });
});

describe('once', () => {
  it('resolves with the next payload and then unsubscribes', async () => {
    const { emitter } = setup();
    const next = emitter.once('count');
    expect(emitter.listenerCount('count')).toBe(1);
    emitter.emit('count', 7);
    emitter.emit('count', 8);
    await expect(next).resolves.toBe(7);
    expect(emitter.listenerCount('count')).toBe(0);
  });

  it('rejects with the abort reason when the signal aborts first, and cleans up', async () => {
    const { emitter } = setup();
    const controller = new AbortController();
    const next = emitter.once('count', { signal: controller.signal });
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(emitter.listenerCount('count')).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { emitter } = setup();
    await expect(emitter.once('count', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(emitter.listenerCount('count')).toBe(0);
  });
});
