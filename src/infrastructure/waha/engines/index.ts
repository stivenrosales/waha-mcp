import { UnsupportedEngineError } from "../../../domain/errors.js";
import type { EngineMapper } from "../../../domain/message.js";
import type { WahaGateway } from "../../../domain/ports/WahaGateway.js";
import { gowsMapper } from "./gows.js";

export function getEngineMapper(engine: string): EngineMapper {
  if (engine === "GOWS") return gowsMapper;
  throw new UnsupportedEngineError(engine);
}

/**
 * Resolves the engine mapper from `getSession()` once per process. Concurrent
 * callers share the pending lookup; a failure (WAHA down, unsupported engine) is
 * not cached, so the next call retries; an unsupported engine is cached.
 */
export function createEngineResolver(
  gw: Pick<WahaGateway, "getSession">,
): () => Promise<EngineMapper> {
  let pending: Promise<EngineMapper> | null = null;
  return () => {
    if (!pending) {
      pending = gw
        .getSession()
        .then((s) => getEngineMapper(s.engine))
        .catch((err: unknown) => {
          // An unsupported engine is permanent (until restart); anything else may be transient.
          if (!(err instanceof UnsupportedEngineError)) pending = null;
          throw err;
        });
    }
    return pending;
  };
}
