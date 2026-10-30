import { describe, expect, it } from "vitest";
import { UnsupportedEngineError, WahaUnavailableError } from "../../../../src/domain/errors.js";
import { createEngineResolver } from "../../../../src/infrastructure/waha/engines/index.js";

function sessions(...answers: (string | Error)[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getSession() {
      const a = answers[Math.min(calls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return { engine: a as string, status: "WORKING" };
    },
  };
}

describe("createEngineResolver", () => {
  it("resolves once and shares the lookup between concurrent callers", async () => {
    const gw = sessions("GOWS");
    const resolve = createEngineResolver(gw);
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a).toBe(b);
    await resolve();
    expect(gw.calls).toBe(1);
  });

  it("caches a permanent UnsupportedEngineError", async () => {
    const gw = sessions("WEBJS", "GOWS");
    const resolve = createEngineResolver(gw);
    await expect(resolve()).rejects.toBeInstanceOf(UnsupportedEngineError);
    await expect(resolve()).rejects.toBeInstanceOf(UnsupportedEngineError);
    expect(gw.calls).toBe(1);
  });

  it("drops transient failures so the next call retries", async () => {
    const gw = sessions(new WahaUnavailableError(), "GOWS");
    const resolve = createEngineResolver(gw);
    await expect(resolve()).rejects.toBeInstanceOf(WahaUnavailableError);
    await expect(resolve()).resolves.toBeDefined();
    expect(gw.calls).toBe(2);
  });
});
