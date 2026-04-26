import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { log, setLogLevel } from "../../src/logger.js";

describe("logger", () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    setLogLevel("info");
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  it("log.info() writes JSON to stderr with ts, level, msg fields", () => {
    log.info("hello");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("ts");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
  });

  it("log.debug() is suppressed when level is info (default)", () => {
    log.debug("should not appear");

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('after setLogLevel("debug"), log.debug() writes output', () => {
    setLogLevel("debug");
    log.debug("visible now");

    expect(stderrSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("debug");
    expect(parsed.msg).toBe("visible now");
  });

  it("log.error() includes extra fields in the JSON", () => {
    log.error("failure", { code: 42, detail: "bad input" });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("failure");
    expect(parsed.code).toBe(42);
    expect(parsed.detail).toBe("bad input");
  });

  it("each log line is valid JSON ending with newline", () => {
    log.info("line1");
    log.warn("line2");

    expect(stderrSpy).toHaveBeenCalledTimes(2);

    for (const call of stderrSpy.mock.calls) {
      const raw = call[0] as string;
      expect(raw.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });
});
