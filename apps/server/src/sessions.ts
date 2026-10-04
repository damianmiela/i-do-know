// Guest sessions. A device that opened the join link has a signed guest cookie (see auth.ts);
// the server stores a record only once the device picks a name (Phase 3), so the number of
// records is bounded by the guest list, not by how often someone opens the join link.
import { ADMIN_COOKIE, GUEST_COOKIE, guestSid, isAdminToken, parseCookies } from './auth';
import { cleanRecord, isNum, isSafeKey, own } from './game/safe';

export interface Session {
  /** When the device picked its name. */
  boundAt: number;
  /** The guest-list entry this device picked. */
  guestId: string;
}

/** Session id → the guest that device picked. Kept in the snapshot. */
export type Sessions = Record<string, Session>;

const SID = /^[A-Za-z0-9_-]{16,64}$/;

/** Rebuilds sessions read from a snapshot; throws if they aren't valid. */
export function restoreSessions(raw: unknown): Sessions {
  return cleanRecord<Session>(
    raw,
    (v, sid) => {
      const s = v as Partial<Session>;
      return (
        SID.test(sid) &&
        typeof s === 'object' &&
        s !== null &&
        isNum(s.boundAt) &&
        isSafeKey(s.guestId)
      );
    },
    'sessions',
  );
}

export class SessionStore {
  constructor(readonly sessions: Sessions = {}) {}

  /** The guest this device picked, or null if it hasn't picked a name yet. */
  guestOf(sid: string): string | null {
    return own(this.sessions, sid)?.guestId ?? null;
  }

  /**
   * Links a device to a guest. Low-level: the name claim (the `guest:claim` action in
   * realtime.ts) checks first that the guest exists and the name is free, which keeps the
   * records bounded.
   */
  bind(sid: string, guestId: string, now: number): boolean {
    if (!SID.test(sid) || !isSafeKey(guestId)) return false;
    this.sessions[sid] = { boundAt: now, guestId };
    return true;
  }

  /** This device gives its name back (it goes back to the name search). */
  unbind(sid: string): void {
    if (Object.hasOwn(this.sessions, sid)) delete this.sessions[sid];
  }

  /** The devices that picked this guest (normally one; a copied cookie can make more). */
  sidsOf(guestId: string): string[] {
    return Object.entries(this.sessions)
      .filter(([, s]) => s.guestId === guestId)
      .map(([sid]) => sid);
  }

  isTaken(guestId: string): boolean {
    return Object.values(this.sessions).some((s) => s.guestId === guestId);
  }

  /** Host: frees a name. Returns the devices that had it (they go back to the name search). */
  release(guestId: string): string[] {
    const sids = this.sidsOf(guestId);
    for (const sid of sids) delete this.sessions[sid];
    return sids;
  }

  /** Drops sessions of guests that are no longer on the list. Returns how many. */
  dropUnknown(exists: (guestId: string) => boolean): number {
    let dropped = 0;
    for (const [sid, s] of Object.entries(this.sessions)) {
      if (!exists(s.guestId)) {
        delete this.sessions[sid];
        dropped++;
      }
    }
    return dropped;
  }
}

export interface Identity {
  admin: boolean;
  /** Set for a correctly signed, unexpired guest cookie. */
  sid?: string;
}

export interface Secrets {
  sessionSecret: string;
  adminPassword: string;
}

/** Who is making this request, from its Cookie header. */
export function identify(
  cookieHeader: string | undefined,
  secrets: Secrets,
  now: number,
): Identity {
  const cookies = parseCookies(cookieHeader);
  const { sessionSecret, adminPassword } = secrets;
  const sid = guestSid(cookies.get(GUEST_COOKIE), now, sessionSecret);
  return {
    admin: isAdminToken(cookies.get(ADMIN_COOKIE), now, sessionSecret, adminPassword),
    ...(sid ? { sid } : {}),
  };
}
