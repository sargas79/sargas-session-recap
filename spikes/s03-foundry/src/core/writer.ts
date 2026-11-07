/**
 * Designated-writer selection. The GM stores one Foundry user id in a world setting; only the client logged in as
 * that user persists events, every other client still counts hook fires (for the probe table) but ignores them.
 *
 * Known limitation to verify in the spike: the setting names a *user*, not a browser tab. If the same user is logged
 * in from two tabs/devices, both write. Export dedup by eventId absorbs that for source-derived ids.
 */

export interface UserLike {
  id: string;
  name?: string;
  active: boolean;
  isGM: boolean;
}

export type WriterStatus = "unset" | "active" | "offline" | "unknown-user";

export interface WriterResolution {
  writerUserId: string | null;
  status: WriterStatus;
}

export function resolveWriter(settingUserId: string | null | undefined, users: readonly UserLike[]): WriterResolution {
  if (!settingUserId) return { writerUserId: null, status: "unset" };
  const user = users.find((u) => u.id === settingUserId);
  if (!user) return { writerUserId: settingUserId, status: "unknown-user" };
  return { writerUserId: settingUserId, status: user.active ? "active" : "offline" };
}

export function isDesignatedWriter(currentUserId: string | null | undefined, settingUserId: string | null | undefined): boolean {
  return !!currentUserId && !!settingUserId && currentUserId === settingUserId;
}

/** Candidates offered in the GM panel: connected users, GMs first. */
export function writerCandidates(users: readonly UserLike[]): UserLike[] {
  return users.filter((u) => u.active).sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.id.localeCompare(b.id));
}
