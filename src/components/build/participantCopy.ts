export type GrowthProgramParticipationStatus = "CLOSED" | "INVITE_ONLY" | "OPEN";

export function participationModeEmptyCopy(mode: GrowthProgramParticipationStatus): string {
  if (mode === "CLOSED") return "No participants yet. This program is closed to new participants.";
  if (mode === "INVITE_ONLY") return "No participants yet. Add or invite approved partners to this program.";
  return "No participants yet. Eligible partners can request to join.";
}

export function shadowParticipantSetupCopy(operatorMode: "SHADOW" | "REVIEW" | "AUTONOMOUS"): string | null {
  return operatorMode === "SHADOW"
    ? "Shadow prevents external invitations and financial execution. Internal participant setup and attribution remain available."
    : null;
}
