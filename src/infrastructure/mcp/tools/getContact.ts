import { z } from "zod";
import { getContact } from "../../../application/contact.js";
import type { ToolDefinition } from "../defineTool.js";
import { contactSchema, label } from "./schemas.js";

const inputSchema = z.object({
  contact_id: z
    .string()
    .min(1)
    .optional()
    .describe('A contact id: phone id ("51987654321@c.us") or lid ("…@lid").'),
  phone: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Phone digits in any format, e.g. "+51 987 654 321"; include the country code for exact matches — a local number is matched by its ending.',
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Part of the saved or push name; case- and accent-insensitive."),
});

export const getContactTool: ToolDefinition<typeof inputSchema, typeof contactSchema> = {
  name: "get_contact",
  title: "Get contact",
  description:
    "Describes one person: ids (phone and lid), saved name and push name, the groups you share with them and the time of your last direct chat activity. Give exactly one of contact_id, phone or name. A name that matches several contacts returns up to 10 candidates instead of guessing: ask which one, then call again with its id. Only information WAHA already exposes is returned.",
  inputSchema,
  outputSchema: contactSchema,
  async run(input, { gateway, mapper }) {
    const r = await getContact(gateway, mapper, {
      contactId: input.contact_id,
      phone: input.phone,
      name: input.name,
    });
    if (r.contact) {
      const c = r.contact;
      const groups = c.groupsInCommon.map((g) => g.name || g.id);
      const text = [
        `${label(c.name ?? c.pushname, c.id)}`,
        `phone: ${c.phone ?? "unknown"} · lid: ${c.lid ?? "unknown"} · saved name: ${c.name ?? "none"} · push name: ${c.pushname ?? "none"}`,
        `last direct chat activity: ${c.lastInteraction ?? "none found"}`,
        `${groups.length} groups in common${groups.length ? `: ${groups.join(", ")}` : ""}`,
      ].join("\n");
      return { text, data: r };
    }
    if (r.match === "none") return { text: "No contact matches that name.", data: r };
    const lines = r.candidates.map(
      (c) => `- ${label(c.name ?? c.pushname, c.id)}${c.phone ? ` · phone ${c.phone}` : ""}`,
    );
    const more = r.totalCandidates > r.candidates.length ? ` (showing ${r.candidates.length})` : "";
    return {
      text: [
        `${r.totalCandidates} contacts match${more}; ask which one, then call again with contact_id:`,
        ...lines,
      ].join("\n"),
      data: r,
    };
  },
};
