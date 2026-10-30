/** Domain errors. Messages never contain the API key or the WAHA base URL. */

export class WahaAuthError extends Error {
  constructor() {
    super("WAHA rejected the credentials (401/403). Check WAHA_API_KEY.");
    this.name = "WahaAuthError";
  }
}

export class WahaNotFoundError extends Error {
  constructor(what = "resource") {
    super(`WAHA ${what} not found.`);
    this.name = "WahaNotFoundError";
  }
}

export class WahaUnavailableError extends Error {
  constructor(reason = "WAHA is unavailable.") {
    super(reason);
    this.name = "WahaUnavailableError";
  }
}

/** WAHA started sending a file and then stopped (no data within the idle timeout). */
export class MediaStalledError extends WahaUnavailableError {
  constructor() {
    super("WAHA did not finish sending the file. Try again later.");
    this.name = "MediaStalledError";
  }
}

export class UnsupportedEngineError extends Error {
  constructor(public readonly engine: string) {
    super(`Unsupported WAHA engine "${engine}". Only GOWS is supported.`);
    this.name = "UnsupportedEngineError";
  }
}

/** The caller supplied an invalid argument (bad range, cursor, timezone...). Message is safe to show. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
