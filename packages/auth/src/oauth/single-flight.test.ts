import { describe, expect, it } from 'vitest';
import { createSingleFlight } from './single-flight.ts';

function gate<T>(): { readonly promise: Promise<T>; open(value: T): void; fail(e: Error): void } {
  let open: (value: T) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const never = new AbortController().signal;

describe('createSingleFlight', () => {
  it('shares one in-flight run among concurrent callers of the same key', async () => {
    const flight = createSingleFlight<string, number>();
    const g = gate<number>();
    let runs = 0;
    const work = () => {
      runs += 1;
      return g.promise;
    };
    const callers = [
      flight.run('a', work, never),
      flight.run('a', work, never),
      flight.run('a', work, never),
    ];
    g.open(7);
    expect(await Promise.all(callers)).toEqual([7, 7, 7]);
    expect(runs).toBe(1);
  });

  it('starts a new run once the previous one settled', async () => {
    const flight = createSingleFlight<string, number>();
    let runs = 0;
    const work = () => Promise.resolve((runs += 1));
    expect(await flight.run('a', work, never)).toBe(1);
    expect(await flight.run('a', work, never)).toBe(2);
  });

  it('runs different keys independently', async () => {
    const flight = createSingleFlight<string, string>();
    const a = gate<string>();
    const b = gate<string>();
    const pa = flight.run('a', () => a.promise, never);
    const pb = flight.run('b', () => b.promise, never);
    b.open('B');
    expect(await pb).toBe('B');
    a.open('A');
    expect(await pa).toBe('A');
  });

  it('shares a rejection, then allows a retry', async () => {
    const flight = createSingleFlight<string, number>();
    const g = gate<number>();
    const callers = [
      flight.run('a', () => g.promise, never),
      flight.run('a', () => g.promise, never),
    ];
    g.fail(new Error('refresh failed'));
    for (const caller of callers) await expect(caller).rejects.toThrow('refresh failed');
    expect(await flight.run('a', () => Promise.resolve(1), never)).toBe(1);
  });

  it('shares a synchronous throw as a rejection', async () => {
    const flight = createSingleFlight<string, number>();
    const work = (): Promise<number> => {
      throw new Error('sync');
    };
    await expect(flight.run('a', work, never)).rejects.toThrow('sync');
    expect(await flight.run('a', () => Promise.resolve(2), never)).toBe(2);
  });

  it('lets one caller stop waiting without cancelling the shared run for others', async () => {
    const flight = createSingleFlight<string, number>();
    const g = gate<number>();
    const controller = new AbortController();
    const quitter = flight.run('a', () => g.promise, controller.signal);
    const stayer = flight.run('a', () => g.promise, never);
    controller.abort();
    await expect(quitter).rejects.toMatchObject({ name: 'AbortError' });
    g.open(9);
    expect(await stayer).toBe(9);
  });

  it('rejects immediately for an already-aborted signal without starting a run', async () => {
    const flight = createSingleFlight<string, number>();
    const controller = new AbortController();
    controller.abort();
    let runs = 0;
    await expect(
      flight.run('a', () => Promise.resolve((runs += 1)), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runs).toBe(0);
  });
});
