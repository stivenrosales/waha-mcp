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

export class UnsupportedEngineError extends Error {
  constructor(public readonly engine: string) {
    super(`Unsupported WAHA engine "${engine}". Only GOWS is supported.`);
    this.name = "UnsupportedEngineError";
  }
}
