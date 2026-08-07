/**
 * In-memory cache for Slack user info lookups.
 *
 * Eliminates N+1 getUserInfo API calls when resolving usernames for
 * thread history or buffered messages. Cache lives for the process lifetime —
 * user display names rarely change mid-session.
 */

export interface CachedUser {
  name: string;
  realName: string;
  email: string | null;
  phone?: string | null;
  tz: string | null;
  isBot: boolean;
  slackUserId?: string;
  displayName?: string;
  profileTeamId?: string | null;
  isGuest?: boolean;
  isStranger?: boolean;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  deleted?: boolean;
  providerUpdatedAt?: string | null;
}

interface CachedUserEntry {
  value: CachedUser;
  fetchedAt: number;
}

export class UserCache {
  private cache = new Map<string, CachedUserEntry>();
  private inflight = new Map<string, Promise<CachedUser>>();

  constructor(
    private readonly ttlMs = 0,
    private readonly now = () => Date.now(),
  ) {}

  async resolve(userId: string, fetcher: (id: string) => Promise<CachedUser>): Promise<CachedUser> {
    const cached = this.cache.get(userId);
    if (cached && (this.ttlMs <= 0 || this.now() - cached.fetchedAt < this.ttlMs)) return cached.value;

    const pending = this.inflight.get(userId);
    if (pending) return pending;

    const request = fetcher(userId).then((value) => {
      if (this.inflight.get(userId) === request) this.cache.set(userId, { value, fetchedAt: this.now() });
      return value;
    });
    this.inflight.set(userId, request);
    try {
      return await request;
    } finally {
      if (this.inflight.get(userId) === request) this.inflight.delete(userId);
    }
  }

  async refresh(userId: string, fetcher: (id: string) => Promise<CachedUser>): Promise<CachedUser> {
    this.cache.delete(userId);
    this.inflight.delete(userId);
    return this.resolve(userId, fetcher);
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
