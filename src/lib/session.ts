import { currentAccount } from './auth';
import { GUEST_TTL_MS } from './limits';

/** The signed-in account's email, or null for a guest. */
export function currentOwner(): string | null {
  return currentAccount()?.email ?? null;
}

/** Guests' files expire after 24 hours; a signed-in user's files are kept until they remove them. */
export function expiryFor(now: number): number | null {
  return currentOwner() ? null : now + GUEST_TTL_MS;
}
