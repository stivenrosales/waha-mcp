export type TenantStatus = "invited" | "pairing" | "active" | "revoked";
export type Role = "admin" | "member";
export type LinkKind = "invite" | "reset";

export interface Tenant {
  id: string;
  wahaSession: string;
  displayName: string;
  status: TenantStatus;
  waId: string | null;
  createdAt: number;
}

export interface User {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
  lastLoginAt: number | null;
}

export interface TenantStore {
  createTenant(q: { displayName: string; wahaSession: string; wrappedDek: string }): Tenant;
  getTenant(id: string): Tenant | null;
  listTenants(): Tenant[];
  getWrappedDek(id: string): string | null;
  setWrappedDek(id: string, wrapped: string): void;
  setStatus(id: string, status: TenantStatus): void;
  /** Atomically moves the tenant from `from` to `to`; false (and no change) when it is not in `from`. */
  transitionStatus(id: string, from: TenantStatus, to: TenantStatus): boolean;
  /** "taken" when another tenant already holds this WhatsApp id. */
  setWaId(id: string, waId: string): "ok" | "taken";
  /** Deletes tenant, its user and links. */
  deleteTenant(id: string): void;
  createUser(q: {
    tenantId: string;
    username: string;
    password: string;
    role: Role;
  }): Promise<User | "username_taken">;
  /** Null on unknown user or wrong password; runs a dummy hash for unknown users. */
  verifyPassword(username: string, password: string): Promise<User | null>;
  setPassword(userId: string, password: string): Promise<void>;
  getUser(userId: string): User | null;
  getUserByTenant(tenantId: string): User | null;
  getAdmin(): User | null;
  touchLogin(userId: string): void;
  /** Invalidates earlier links of the same kind for the tenant. */
  issueLink(tenantId: string, kind: LinkKind, ttlMs: number): { token: string; expiresAt: number };
  peekLink(token: string, kind: LinkKind): { tenantId: string } | null;
  /** Like `peekLink`, but also reports used and expired links (for precise page errors). */
  linkState(
    token: string,
    kind: LinkKind,
  ): { tenantId: string; state: "valid" | "used" | "expired" } | null;
  /** Atomic single use. */
  consumeLink(token: string, kind: LinkKind): { tenantId: string } | null;
}
