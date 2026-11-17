import type { MissionTenantPort } from "../../application/missions/engine.js";
import { openMediaById, readCapped } from "../media/resolveMedia.js";
import type { TenantRuntime } from "../tenants/runtime.js";

/** The mission engine's view of one tenant runtime. */
export function missionTenantPort(runtime: TenantRuntime): MissionTenantPort {
  const ctx = runtime.context;
  return {
    log: runtime.missionLog,
    sender: ctx.sender,
    openEvent: (e) =>
      runtime.cipher.openText(e.payloadSealed, `webhook:${e.tenantId}:${e.eventId}`),
    mapper: () => ctx.mapper(),
    lookupLid: (lid) => ctx.gateway.lookupLid(lid),
    async transcribe(mediaId) {
      if (!ctx.transcription.enabled) return null;
      const r = await ctx.transcription.transcribeMedia(mediaId, await ctx.mapper());
      return r.status === "ok" ? r.transcript : null;
    },
    async fetchMedia(mediaId, maxBytes) {
      const opened = await openMediaById(ctx.gateway, mediaId);
      if (!opened) return null;
      if (opened.length !== null && opened.length > maxBytes) {
        await opened.body.cancel().catch(() => {});
        return null;
      }
      const data = await readCapped(opened.body, maxBytes);
      return data ? { data, mimetype: opened.mimetype } : null;
    },
  };
}
