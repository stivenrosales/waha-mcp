import type { SessionAdmin, SessionState } from "../../src/domain/ports/SessionAdmin.js";

interface FakeSession {
  state: SessionState;
  me: { id: string } | null;
  qr: { mimetype: string; base64: string };
}

/** In-memory SessionAdmin for tests: states and accounts are set per session. */
export class FakeSessionAdmin implements SessionAdmin {
  readonly sessions = new Map<string, FakeSession>();
  /** Every call as `method:name`, in order. */
  readonly calls: string[] = [];

  setState(name: string, state: SessionState): void {
    this.ensure(name).state = state;
  }

  setMe(name: string, id: string | null): void {
    this.ensure(name).me = id === null ? null : { id };
  }

  private ensure(name: string): FakeSession {
    let s = this.sessions.get(name);
    if (!s) {
      s = { state: "STOPPED", me: null, qr: { mimetype: "image/png", base64: "ZmFrZS1xcg==" } };
      this.sessions.set(name, s);
    }
    return s;
  }

  async create(name: string): Promise<void> {
    this.calls.push(`create:${name}`);
    const s = this.ensure(name);
    s.state = "STARTING";
  }

  async start(name: string): Promise<void> {
    this.calls.push(`start:${name}`);
    this.ensure(name).state = "STARTING";
  }

  async state(name: string): Promise<SessionState> {
    this.calls.push(`state:${name}`);
    return this.sessions.get(name)?.state ?? "UNKNOWN";
  }

  async qr(name: string): Promise<{ mimetype: string; base64: string } | null> {
    this.calls.push(`qr:${name}`);
    const s = this.sessions.get(name);
    return s?.state === "SCAN_QR_CODE" ? s.qr : null;
  }

  async me(name: string): Promise<{ id: string } | null> {
    this.calls.push(`me:${name}`);
    return this.sessions.get(name)?.me ?? null;
  }

  async logout(name: string): Promise<void> {
    this.calls.push(`logout:${name}`);
    const s = this.sessions.get(name);
    if (s) {
      s.me = null;
      s.state = "SCAN_QR_CODE";
    }
  }

  async remove(name: string): Promise<void> {
    this.calls.push(`remove:${name}`);
    this.sessions.delete(name);
  }
}
