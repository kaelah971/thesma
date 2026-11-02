import { describe, expect, it } from "vitest";
import { participationModeEmptyCopy, shadowParticipantSetupCopy } from "@/components/build/participantCopy";

describe("Growth Program participant UI copy", () => {
  it("matches the persisted participation mode", () => {
    expect(participationModeEmptyCopy("CLOSED")).toBe("No participants yet. This program is closed to new participants.");
    expect(participationModeEmptyCopy("INVITE_ONLY")).toBe("No participants yet. Add or invite approved partners to this program.");
    expect(participationModeEmptyCopy("OPEN")).toBe("No participants yet. Eligible partners can request to join.");
  });

  it("explains Shadow without blocking internal setup", () => {
    expect(shadowParticipantSetupCopy("SHADOW")).toContain("Internal participant setup and attribution remain available.");
    expect(shadowParticipantSetupCopy("SHADOW")).toContain("external invitations");
    expect(shadowParticipantSetupCopy("AUTONOMOUS")).toBeNull();
  });
});
