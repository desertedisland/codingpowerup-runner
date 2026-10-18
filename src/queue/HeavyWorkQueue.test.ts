// The heavy-work queue: at most FACTORY_HEAVY_CONCURRENCY jobs at once, the rest in order, slots
// freed even when a job fails, and every change announced on its emitter.
import { IHeavyQueueStatus } from '@yellowmelon/factory-global-types';
import { enqueueHeavyWork, heavyConcurrency, heavyQueueStatus, queueEvents } from './HeavyWorkQueue';

// A job the test finishes by hand, so it can look at the queue in between
const controllableJob = () => {
  let finish: (value: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  return { work: () => promise, finish: (value: string) => finish(value), fail: (error: Error) => fail(error) };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  delete process.env.FACTORY_HEAVY_CONCURRENCY;
});

describe('heavyConcurrency', () => {

  it('defaults to 2 and ignores anything that is not a whole number of at least 1', () => {
    expect(heavyConcurrency()).toEqual(2);
    process.env.FACTORY_HEAVY_CONCURRENCY = '3';
    expect(heavyConcurrency()).toEqual(3);
    ['0', '-1', '1.5', 'two'].forEach((value) => {
      process.env.FACTORY_HEAVY_CONCURRENCY = value;
      expect(heavyConcurrency()).toEqual(2);
    });
  });

});

describe('enqueueHeavyWork', () => {

  it('runs two at once, queues the third, and starts it when a slot frees', async () => {

    const [first, second, third] = [controllableJob(), controllableJob(), controllableJob()];
    const queuedBehind: string[][] = [];

    const firstResult = enqueueHeavyWork('goalzen checks', first.work);
    enqueueHeavyWork('tucolingo checks', second.work);
    const thirdResult = enqueueHeavyWork('zentrace checks', third.work, (ahead) => queuedBehind.push(ahead));
    await flush();

    expect(heavyQueueStatus()).toEqual({ running: ['goalzen checks', 'tucolingo checks'], waiting: ['zentrace checks'], concurrency: 2 });
    expect(queuedBehind).toEqual([['goalzen checks', 'tucolingo checks']]);

    first.finish('green');
    expect(await firstResult).toEqual('green');
    await flush();
    expect(heavyQueueStatus().running).toEqual(['tucolingo checks', 'zentrace checks']);

    second.finish('done');
    third.finish('also green');
    expect(await thirdResult).toEqual('also green');
    await flush();
    expect(heavyQueueStatus()).toEqual({ running: [], waiting: [], concurrency: 2 });

  });

  it('honours a concurrency of 1', async () => {

    process.env.FACTORY_HEAVY_CONCURRENCY = '1';
    const [first, second] = [controllableJob(), controllableJob()];

    enqueueHeavyWork('a', first.work);
    const secondResult = enqueueHeavyWork('b', second.work);
    await flush();
    expect(heavyQueueStatus()).toMatchObject({ running: ['a'], waiting: ['b'] });

    first.finish('x');
    second.finish('y');
    expect(await secondResult).toEqual('y');

  });

  it('frees the slot when a job fails, including one that throws straight away', async () => {

    const failing = controllableJob();
    const failed = enqueueHeavyWork('broken build', failing.work);
    const thrown = enqueueHeavyWork('throws at once', () => { throw new Error('no such command'); });
    const next = enqueueHeavyWork('next build', async () => 'ran');

    failing.fail(new Error('tsc failed'));
    await expect(failed).rejects.toThrow('tsc failed');
    await expect(thrown).rejects.toThrow('no such command');
    expect(await next).toEqual('ran');
    await flush();
    expect(heavyQueueStatus().running).toEqual([]);

  });

  it('announces every change on its emitter, for the connection to report', async () => {

    const queues: IHeavyQueueStatus[] = [];
    const listener = (queue: IHeavyQueueStatus) => queues.push(queue);
    queueEvents.on('change', listener);

    await enqueueHeavyWork('goalzen checks', async () => 'ok');
    await flush();
    queueEvents.off('change', listener);

    expect(queues[0]).toEqual({ running: [], waiting: ['goalzen checks'], concurrency: 2 });
    expect(queues).toContainEqual({ running: ['goalzen checks'], waiting: [], concurrency: 2 });
    expect(queues[queues.length - 1]).toEqual({ running: [], waiting: [], concurrency: 2 });

  });

});
