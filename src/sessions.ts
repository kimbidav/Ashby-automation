/**
 * sessions.ts — per-recruiter Ashby sessions.
 *
 * Every write to a client's ATS must run under the recruiter's OWN Ashby
 * login: that is what makes "credited to" and the visible org list theirs
 * without any guessing. Each recruiter seeds their session once (cookie from
 * their browser, verified against their email, see server.ts) and it is
 * kept here as one file per user, rotated on every Set-Cookie exactly like
 * the team session (session.ts persistSessionCookies with a per-file path).
 *
 * Files live under ASHBY_SESSIONS_DIR (a Railway volume, /data/sessions) and
 * hold live credentials. When SESSION_ENC_KEY is set (32 bytes, base64 or
 * hex) each file is AES-256-GCM encrypted at rest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AshbySession } from './types.js';

export const SESSIONS_DIR = process.env.ASHBY_SESSIONS_DIR || path.join(process.cwd(), '.ashby-sessions');

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

export function emailHash(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 32);
}

export function sessionPathFor(email: string, dir: string = SESSIONS_DIR): string {
  return path.join(dir, `${emailHash(email)}.json`);
}

// ── at-rest encryption (optional) ────────────────────────────────────────

function encKey(): Buffer | null {
  const raw = process.env.SESSION_ENC_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('SESSION_ENC_KEY must be 32 bytes (hex or base64)');
  return buf;
}

export function encodeSessionFile(json: string, key: Buffer | null = encKey()): string {
  if (!key) return json;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return JSON.stringify({ enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') });
}

export function decodeSessionFile(content: string, key: Buffer | null = encKey()): string {
  const parsed = JSON.parse(content);
  if (!parsed || parsed.enc !== 'aes-256-gcm') return content;
  if (!key) throw new Error('session file is encrypted but SESSION_ENC_KEY is not set');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
}

// ── stored shape ─────────────────────────────────────────────────────────

export interface StoredUserSession {
  cookies: Record<string, string>;
  csrfToken?: string;
  seedHash?: string;
  persistedAt?: string;
  userEmail: string;
  /** org id -> the recruiter's own Ashby user id in that org (from available_identities). */
  identityUserIds: Record<string, string>;
  orgCount: number;
  seededAt: string;
  /** Health from the last probe (server-side timer or status call). */
  status: 'healthy' | 'expired' | 'unknown';
  lastOkAt?: string;
  lastError?: string;
}

export function toAshbySession(stored: StoredUserSession, filePath: string): AshbySession {
  return {
    cookies: stored.cookies,
    csrfToken: stored.csrfToken,
    orgIds: Object.keys(stored.identityUserIds || {}),
    seedHash: stored.seedHash,
    persistPath: filePath,
    userEmail: stored.userEmail,
    identityUserIds: stored.identityUserIds,
  };
}

export async function readUserSessionFile(email: string, dir = SESSIONS_DIR): Promise<StoredUserSession | null> {
  try {
    const raw = await fs.readFile(sessionPathFor(email, dir), 'utf8');
    const parsed = JSON.parse(decodeSessionFile(raw)) as StoredUserSession;
    if (!parsed?.cookies || !(parsed.cookies['ashby_session_token'] || parsed.cookies['authenticated'])) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The recruiter's session, or null when they have never connected (or it was cleared). */
export async function loadUserSession(email: string, dir = SESSIONS_DIR): Promise<AshbySession | null> {
  const stored = await readUserSessionFile(email, dir);
  return stored ? toAshbySession(stored, sessionPathFor(email, dir)) : null;
}

// Per-file write chains so concurrent rotations for one user can't interleave.
const chains = new Map<string, Promise<void>>();

export async function writeUserSessionFile(email: string, stored: StoredUserSession, dir = SESSIONS_DIR): Promise<void> {
  const filePath = sessionPathFor(email, dir);
  const payload = encodeSessionFile(JSON.stringify({ ...stored, userEmail: normalizeEmail(email), persistedAt: new Date().toISOString() }, null, 2));
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, filePath);
  });
  chains.set(filePath, next.catch(() => undefined));
  return next;
}

/** Merge a field update into the stored file (status, lastOkAt, ...). */
export async function updateUserSessionFile(email: string, patch: Partial<StoredUserSession>, dir = SESSIONS_DIR): Promise<void> {
  const stored = await readUserSessionFile(email, dir);
  if (!stored) return;
  await writeUserSessionFile(email, { ...stored, ...patch }, dir);
}

export async function deleteUserSession(email: string, dir = SESSIONS_DIR): Promise<boolean> {
  try {
    await fs.unlink(sessionPathFor(email, dir));
    return true;
  } catch {
    return false;
  }
}

export interface UserSessionSummary {
  email: string;
  status: StoredUserSession['status'];
  seeded_at: string;
  persisted_at?: string;
  last_ok_at?: string;
  last_error?: string;
  org_count: number;
}

export async function listUserSessions(dir = SESSIONS_DIR): Promise<UserSessionSummary[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: UserSessionSummary[] = [];
  for (const name of names) {
    try {
      const stored = JSON.parse(decodeSessionFile(await fs.readFile(path.join(dir, name), 'utf8'))) as StoredUserSession;
      if (!stored?.userEmail) continue;
      out.push({
        email: stored.userEmail,
        status: stored.status ?? 'unknown',
        seeded_at: stored.seededAt,
        persisted_at: stored.persistedAt,
        last_ok_at: stored.lastOkAt,
        last_error: stored.lastError,
        org_count: stored.orgCount ?? 0,
      });
    } catch {
      // unreadable file: skip, never crash the listing
    }
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}
