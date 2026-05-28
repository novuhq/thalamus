import { describe, expect, it, vi } from "vitest";
import {
  adaptPinoLogger,
  createConsoleLogger,
  resolveLogger,
  silentLogger,
} from "../src/logger.js";

describe("resolveLogger", () => {
  it("returns silent logger by default", () => {
    const log = resolveLogger();
    expect(log).toBe(silentLogger);
    expect(() => log.info("test", { stage: "test" })).not.toThrow();
  });

  it("supports debug shorthand", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = resolveLogger("debug");
    log.debug("hello", { stage: "hello", runId: "abc" });
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("supports partial custom loggers", () => {
    const info = vi.fn();
    const log = resolveLogger({ info });
    log.info("event", { stage: "event" });
    log.warn("ignored", { stage: "ignored" });
    expect(info).toHaveBeenCalledWith("event", { stage: "event" });
  });
});

describe("adaptPinoLogger", () => {
  it("maps message/context to pino argument order", () => {
    const pino = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = adaptPinoLogger(pino);
    log.info("edge.observe.ok", { stage: "edge.observe.ok", runId: "r1" });
    expect(pino.info).toHaveBeenCalledWith(
      { stage: "edge.observe.ok", runId: "r1" },
      "edge.observe.ok",
    );
  });
});

describe("createConsoleLogger", () => {
  it("respects minimum level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createConsoleLogger({ level: "info" });
    log.debug("hidden", { stage: "hidden" });
    log.info("visible", { stage: "visible" });
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
