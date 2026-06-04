import { describe, expect, it } from "vitest";
import { SessionMutex } from "../src/session-turn-lock.js";

describe("SessionMutex", () => {
  it("first acquire resolves immediately", async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire("sess_1");
    expect(release).toBeTypeOf("function");
    release();
  });

  it("second acquire waits until first releases", async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire("sess_1");
    order.push(1);

    const second = mutex.acquire("sess_1").then((release2) => {
      order.push(2);
      release2();
    });

    await Promise.resolve();
    expect(order).toEqual([1]);

    release1();
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("different sessions do not block each other", async () => {
    const mutex = new SessionMutex();
    const release1 = await mutex.acquire("sess_1");
    const release2 = await mutex.acquire("sess_2");
    expect(release1).toBeTypeOf("function");
    expect(release2).toBeTypeOf("function");
    release1();
    release2();
  });

  it("queues multiple waiters in FIFO order", async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire("sess_1");

    const p2 = mutex.acquire("sess_1").then((r) => {
      order.push(2);
      r();
    });
    const p3 = mutex.acquire("sess_1").then((r) => {
      order.push(3);
      r();
    });
    const p4 = mutex.acquire("sess_1").then((r) => {
      order.push(4);
      r();
    });

    release1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  it("acquire with abort signal rejects if aborted while waiting", async () => {
    const mutex = new SessionMutex();
    const release1 = await mutex.acquire("sess_1");

    const controller = new AbortController();
    const second = mutex.acquire("sess_1", controller.signal);

    controller.abort();

    await expect(second).rejects.toThrow("aborted");
    release1();
  });

  it("abort does not affect other waiters", async () => {
    const mutex = new SessionMutex();
    const release1 = await mutex.acquire("sess_1");

    const controller = new AbortController();
    const second = mutex.acquire("sess_1", controller.signal);
    const third = mutex.acquire("sess_1");

    controller.abort();
    await expect(second).rejects.toThrow("aborted");

    release1();
    const release3 = await third;
    expect(release3).toBeTypeOf("function");
    release3();
  });

  it("enforces max queue depth (waiters only, holder excluded)", async () => {
    const mutex = new SessionMutex({ maxQueueSize: 2 });
    const release1 = await mutex.acquire("sess_1");

    const _p2 = mutex.acquire("sess_1");
    const _p3 = mutex.acquire("sess_1");

    await expect(mutex.acquire("sess_1")).rejects.toThrow("queue is full");
    release1();
  });

  it("release cleans up when no waiters", async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire("sess_1");
    release();
    const release2 = await mutex.acquire("sess_1");
    release2();
  });
});
