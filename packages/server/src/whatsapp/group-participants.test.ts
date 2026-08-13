import { describe, expect, it, vi } from "vitest";
import { collectWhatsAppGroupParticipants } from "./group-participants";

/**
 * Fixtures below are copied verbatim from a live `groupMetadata()` response for
 * a lid-addressed group. WhatsApp returns the phone as a PN JID and supplies no
 * name field of any kind — no `name`, `notify`, or `verifiedName`.
 */
const LIVE_LID_GROUP_PARTICIPANTS = [
  { id: "149916051591191@lid", phoneNumber: "919969577769@s.whatsapp.net", admin: "superadmin" },
  { id: "3878523285582@lid", phoneNumber: "919891688787@s.whatsapp.net", admin: null },
  { id: "27596070871045@lid", phoneNumber: "917977430265@s.whatsapp.net", admin: null },
];

describe("collectWhatsAppGroupParticipants", () => {
  it("extracts the phone from a PN JID without consulting the LID resolver", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue(null);

    const collected = await collectWhatsAppGroupParticipants(
      { participants: LIVE_LID_GROUP_PARTICIPANTS },
      resolveLidToPhone,
    );

    expect(collected.skippedCount).toBe(0);
    expect(collected.participants).toEqual([
      { jid: "149916051591191@lid", phoneE164: "+919969577769", lid: "149916051591191@lid", admin: "superadmin" },
      { jid: "3878523285582@lid", phoneE164: "+919891688787", lid: "3878523285582@lid", admin: null },
      { jid: "27596070871045@lid", phoneE164: "+917977430265", lid: "27596070871045@lid", admin: null },
    ]);
    expect(resolveLidToPhone).not.toHaveBeenCalled();
  });

  it("falls back to the LID resolver only when no phoneNumber is supplied", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue("+15555000123");

    const collected = await collectWhatsAppGroupParticipants(
      { participants: [{ id: "44445555@lid", admin: null }] },
      resolveLidToPhone,
    );

    expect(collected.participants[0].phoneE164).toBe("+15555000123");
    expect(resolveLidToPhone).toHaveBeenCalledWith("44445555@lid");
  });

  it("keeps a lid-only participant when the resolver cache misses", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue(null);

    const collected = await collectWhatsAppGroupParticipants(
      { participants: [{ id: "44445555@lid", admin: null }] },
      resolveLidToPhone,
    );

    expect(collected.participants).toEqual([
      { jid: "44445555@lid", phoneE164: null, lid: "44445555@lid", admin: null },
    ]);
  });

  it("never treats a LID as a phone number", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue(null);

    const collected = await collectWhatsAppGroupParticipants(
      { participants: [{ id: "3878523285582@lid", phoneNumber: "149916051591191@lid", admin: null }] },
      resolveLidToPhone,
    );

    expect(collected.participants[0].phoneE164).toBeNull();
  });

  it("strips a device suffix from the PN JID", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue(null);

    const collected = await collectWhatsAppGroupParticipants(
      { participants: [{ id: "3878523285582@lid", phoneNumber: "919891688787:12@s.whatsapp.net", admin: null }] },
      resolveLidToPhone,
    );

    expect(collected.participants[0].phoneE164).toBe("+919891688787");
  });

  it("still accepts an already-normalized E.164 phoneNumber", async () => {
    const resolveLidToPhone = vi.fn().mockResolvedValue(null);

    const collected = await collectWhatsAppGroupParticipants(
      { participants: [{ id: "3878523285582@lid", phoneNumber: "+919891688787", admin: null }] },
      resolveLidToPhone,
    );

    expect(collected.participants[0].phoneE164).toBe("+919891688787");
  });
});
