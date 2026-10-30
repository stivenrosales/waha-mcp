import { UnsupportedEngineError } from "../../../domain/errors.js";
import type { EngineMapper } from "../../../domain/message.js";
import { gowsMapper } from "./gows.js";

export function getEngineMapper(engine: string): EngineMapper {
  if (engine === "GOWS") return gowsMapper;
  throw new UnsupportedEngineError(engine);
}
