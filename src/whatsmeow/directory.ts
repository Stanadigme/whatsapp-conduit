import type {
  GroupInfo,
  GroupInfoEvent,
  UserInfo,
} from "@whatsmeow-node/whatsmeow-node";
import type { Logger } from "pino";
import type { Database } from "../db/index.js";
import {
  listDirectoryKnownContactJids,
  getDirectoryEntityByJid,
  markDirectoryMissingMembersInactive,
  upsertDirectoryContact,
  upsertDirectoryGroup,
  upsertDirectoryGroupMember,
} from "../db/directory.js";
import { normalizeJid } from "../baileys/jid.js";
import { nowSec } from "../util/time.js";
import type {
  DirectoryReadTransport,
  TransportMessageEvent,
} from "../transport/types.js";

export interface DirectorySyncDeps {
  db: Database;
  accountId: string;
  logger: Logger;
  transport: DirectoryReadTransport;
}

export interface DirectorySyncReport {
  groups: number;
  members: number;
  contacts: number;
}

export interface DirectorySyncSelection {
  groups?: boolean;
  contacts?: boolean;
  jid?: string;
}

export class DirectorySync {
  private readonly deps: DirectorySyncDeps;

  constructor(deps: DirectorySyncDeps) {
    this.deps = deps;
  }

  /** Attach metadata-only listeners to the live transport. */
  register(): void {
    this.deps.transport.on("message", (event) => {
      this.observeMessage(event);
    });
    this.deps.transport.on("group:joined", (event) => {
      const jid = normalizeJid(event.jid);
      try {
        upsertDirectoryGroup(this.deps.db, {
          accountId: this.deps.accountId,
          jid,
          name: event.name,
          nameSource: "group_joined",
        });
      } catch (error) {
        this.logFailure("persist joined group", error);
      }
    });
    this.deps.transport.on("group:info", (event) => {
      try {
        this.applyGroupDelta(event);
      } catch (error) {
        this.logFailure("persist group metadata", error);
      }
    });
  }

  async syncJoinedGroups(): Promise<DirectorySyncReport> {
    const report = await this.syncGroups();
    const contacts = await this.syncContacts();
    return { ...report, contacts };
  }

  async sync(
    selection: DirectorySyncSelection = {},
  ): Promise<DirectorySyncReport> {
    const requestedJid = selection.jid
      ? normalizeJid(selection.jid)
      : undefined;
    const jidIsGroup = requestedJid?.endsWith("@g.us") ?? false;
    const groups =
      selection.groups ?? (requestedJid === undefined || jidIsGroup);
    const contacts =
      selection.contacts ?? (requestedJid === undefined || !jidIsGroup);
    if (!groups && !contacts) return { groups: 0, members: 0, contacts: 0 };
    if (requestedJid !== undefined) {
      const jid = requestedJid;
      if (jid.endsWith("@g.us")) {
        if (!groups || contacts) {
          throw new Error("a group JID can only be synchronized with --groups");
        }
        return { ...(await this.syncGroups(jid)), contacts: 0 };
      }
      if (!contacts || groups) {
        throw new Error(
          "a contact JID can only be synchronized with --contacts",
        );
      }
      return {
        groups: 0,
        members: 0,
        contacts: await this.syncContacts([jid]),
      };
    }
    const groupReport = groups
      ? await this.syncGroups()
      : { groups: 0, members: 0 };
    const contactCount = contacts ? await this.syncContacts() : 0;
    return { ...groupReport, contacts: contactCount };
  }

  private async syncGroups(
    jid?: string,
  ): Promise<Pick<DirectorySyncReport, "groups" | "members">> {
    const groups = jid
      ? [await this.deps.transport.getGroupInfo(normalizeJid(jid))]
      : await this.deps.transport.getJoinedGroups();
    let members = 0;
    for (const group of groups) {
      members += this.persistGroupSnapshot(group);
    }
    return { groups: groups.length, members };
  }

  /** Refresh one group using the full metadata endpoint. */
  async refreshGroup(jid: string): Promise<number> {
    const group = await this.deps.transport.getGroupInfo(normalizeJid(jid));
    return this.persistGroupSnapshot(group);
  }

  private observeMessage(event: TransportMessageEvent): void {
    const info = event.info;
    const pushName = clean(info.pushName);
    if (!pushName || info.isFromMe || !info.sender) return;

    const senderJid = normalizeJid(info.sender);
    try {
      upsertDirectoryContact(this.deps.db, {
        accountId: this.deps.accountId,
        jid: senderJid,
        lid: senderJid.endsWith("@lid") ? senderJid : null,
        pushName,
      });
    } catch (error) {
      this.logFailure("persist contact push name", error);
    }
  }

  private applyGroupDelta(event: GroupInfoEvent): void {
    const groupJid = normalizeJid(event.jid);
    const tx = this.deps.db.transaction(() => {
      upsertDirectoryGroup(this.deps.db, {
        accountId: this.deps.accountId,
        jid: groupJid,
        name: event.name,
        nameSource: "group_info",
      });
      for (const jid of event.join ?? []) {
        this.persistMember(jid, groupJid, undefined, true);
      }
      for (const jid of event.leave ?? []) {
        this.persistMember(jid, groupJid, undefined, false);
      }
      for (const jid of event.promote ?? []) {
        this.persistMember(jid, groupJid, "admin", true);
      }
      for (const jid of event.demote ?? []) {
        this.persistMember(jid, groupJid, "member", true);
      }
    });
    tx();
  }

  private persistGroupSnapshot(group: GroupInfo): number {
    const groupJid = normalizeJid(group.jid);
    const tx = this.deps.db.transaction(() => {
      upsertDirectoryGroup(this.deps.db, {
        accountId: this.deps.accountId,
        jid: groupJid,
        name: group.name,
        nameSource: "group_info",
        lastSyncedAt: nowSec(),
      });
      const activeJids: string[] = [];
      for (const member of group.participants) {
        const participantJid = normalizeJid(member.jid);
        activeJids.push(participantJid);
        this.persistMember(
          participantJid,
          groupJid,
          member.isSuperAdmin
            ? "superadmin"
            : member.isAdmin
              ? "admin"
              : "member",
          true,
        );
      }
      markDirectoryMissingMembersInactive(
        this.deps.db,
        this.deps.accountId,
        groupJid,
        activeJids,
      );
      return group.participants.length;
    });
    return tx();
  }

  private persistMember(
    participantJid: string,
    groupJid: string,
    role: "member" | "admin" | "superadmin" | undefined,
    isActive: boolean,
  ): void {
    const jid = normalizeJid(participantJid);
    upsertDirectoryGroupMember(this.deps.db, {
      accountId: this.deps.accountId,
      groupJid,
      participantJid: jid,
      role,
      isActive,
    });
  }

  private async syncContacts(jids?: string[]): Promise<number> {
    const known =
      jids ?? listDirectoryKnownContactJids(this.deps.db, this.deps.accountId);
    const canonicalJids = known.map((jid) => {
      const entity = getDirectoryEntityByJid(
        this.deps.db,
        this.deps.accountId,
        jid,
        "contact",
      );
      if (!entity) throw new Error("contact JID is not known to the directory");
      return entity.canonical_jid;
    });
    let enriched = 0;
    for (let offset = 0; offset < canonicalJids.length; offset += 50) {
      const batch = canonicalJids.slice(offset, offset + 50);
      let users: Record<string, UserInfo>;
      try {
        users = await this.deps.transport.getUserInfo(batch);
      } catch (error) {
        this.logFailure("enrich known contacts", error);
        continue;
      }
      for (const [jid, user] of Object.entries(users)) {
        const verifiedName = clean(user.verifiedName);
        upsertDirectoryContact(this.deps.db, {
          accountId: this.deps.accountId,
          jid: normalizeJid(jid),
          verifiedName,
          lastSyncedAt: nowSec(),
        });
        if (verifiedName) enriched += 1;
      }
    }
    return enriched;
  }

  private logFailure(operation: string, error: unknown): void {
    this.deps.logger.warn(
      {
        operation,
        error:
          error instanceof Error
            ? "metadata operation failed"
            : "unknown error",
      },
      "directory metadata operation failed",
    );
  }
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
