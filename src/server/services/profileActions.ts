import { campaignName } from "@/lib/format";

/**
 * Public-profile → collaboration bridge (pure decision layer).
 *
 * Decides which call-to-action a viewer of /@handle gets. Rendering lives in
 * the profile page; invitation economics/authorization live in the existing
 * matching + invitation services. This module only routes — it never creates
 * invitations, referrals, reservations, or payouts, and it never exposes a
 * creator's private dashboard to anyone but its owner.
 */

export interface InviteCampaignOption {
  campaignId: string;
  workspaceName: string;
  label: string;
  state: string;
  /** Canonical campaign page with the creator pre-highlighted in Creator Matches. */
  href: string;
}

export type ProfileAction =
  | { kind: "self"; dashboardHref: "/creator" }
  | { kind: "org-invite"; options: InviteCampaignOption[] }
  | { kind: "org-empty"; newCampaignHref: "/app/campaigns/new" }
  | { kind: "guest"; startHref: "/start?role=organization" }
  | { kind: "neutral" };

/** Campaign states that can accept an invitation today (live or approved pre-funding). */
export const INVITABLE_CAMPAIGN_STATES = ["APPROVED", "LIVE"] as const;

export const MAX_PROFILE_CAMPAIGN_OPTIONS = 10;

export function resolveProfileActions(args: {
  isSelf: boolean;
  isOrgMember: boolean;
  inviteOptions: InviteCampaignOption[];
}): ProfileAction {
  if (args.isSelf) return { kind: "self", dashboardHref: "/creator" };
  if (!args.isOrgMember) return { kind: "neutral" };
  if (args.inviteOptions.length > 0) return { kind: "org-invite", options: args.inviteOptions };
  return { kind: "org-empty", newCampaignHref: "/app/campaigns/new" };
}

export function guestProfileAction(): ProfileAction {
  return { kind: "guest", startHref: "/start?role=organization" };
}

export interface OrgInviteCampaignDeps {
  listMemberships: (userId: string) => Promise<{ workspaceId: string; workspaceName: string; role: string }[]>;
  listCampaigns: (workspaceId: string) => Promise<{ id: string; state: string }[]>;
  getIntent: (campaignId: string) => Promise<string | null>;
}

function isOrgRole(role: string): boolean {
  return role === "ORGANIZATION_OWNER" || role === "ORGANIZATION_MEMBER";
}

/**
 * Read-only lookup of the viewer's invitable campaigns across every
 * workspace they own/are a member of. Returns membership truth alongside
 * options so callers can distinguish "org without campaigns" (guidance)
 * from "not an org member" (neutral). Only reads — never writes.
 */
export async function loadOrgInviteCampaigns(
  deps: OrgInviteCampaignDeps,
  viewerUserId: string,
  creatorUserId: string,
  max: number = MAX_PROFILE_CAMPAIGN_OPTIONS,
): Promise<{ isOrgMember: boolean; options: InviteCampaignOption[] }> {
  const memberships = await deps.listMemberships(viewerUserId).catch(() => []);
  const org = memberships.filter((m) => isOrgRole(m.role));
  if (org.length === 0) return { isOrgMember: false, options: [] };
  const options: InviteCampaignOption[] = [];
  for (const m of org) {
    if (options.length >= max) break;
    const campaigns = await deps.listCampaigns(m.workspaceId).catch(() => []);
    for (const c of campaigns) {
      if (options.length >= max) break;
      if (!(INVITABLE_CAMPAIGN_STATES as readonly string[]).includes(c.state)) continue;
      const intent = await deps.getIntent(c.id).catch(() => null);
      options.push({
        campaignId: c.id,
        workspaceName: m.workspaceName,
        label: campaignName(intent),
        state: c.state,
        href: `/app/campaigns/${c.id}?creator=${encodeURIComponent(creatorUserId)}`,
      });
    }
  }
  return { isOrgMember: true, options };
}
