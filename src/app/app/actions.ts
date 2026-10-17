"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAppSession, WORKSPACE_COOKIE } from "./data";

/** Switch the active workspace (membership-checked; UI preference only). */
export async function selectWorkspace(formData: FormData) {
  const id = String(formData.get("workspaceId") ?? "");
  const session = await getAppSession();
  if (session.kind !== "ok" || !session.workspaces.some((w) => w.id === id)) return;
  (await cookies()).set(WORKSPACE_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/app");
}
