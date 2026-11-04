import { createTenantCipher, generateDek } from "../../src/infrastructure/crypto/envelope.js";

/** A cipher with a fresh random key, for tests that only need stores to work. */
export const testCipher = (tenantId = "t1") => createTenantCipher(generateDek(), tenantId);
