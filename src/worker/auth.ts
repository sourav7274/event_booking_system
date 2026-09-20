import { importSPKI, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import { AppError } from './errors';
import type { AuthUser, Env, Role } from './types';

type ClerkClaims = { sub: string; email?: string; email_address?: string };

function organizerIds(env: Env): Set<string> {
  return new Set(env.ORGANIZER_CLERK_IDS.split(',').map((id) => id.trim()).filter(Boolean));
}

async function verifyIdentity(header: string | undefined, env: Env): Promise<{ clerkId: string; email: string }> {
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
  const token = header.slice(7);
  if (!env.CLERK_JWT_PUBLIC_KEY) throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
  try {
    const key = await importSPKI(env.CLERK_JWT_PUBLIC_KEY.replace(/\\n/g, '\n'), 'RS256');
    const { payload } = await jwtVerify(token, key, {
      issuer: env.CLERK_ISSUER,
      audience: env.CLERK_AUDIENCE,
      algorithms: ['RS256'],
    });
    const claims = payload as ClerkClaims;
    const email = claims.email ?? claims.email_address;
    if (!claims.sub || !email) throw new AppError(401, 'INVALID_TOKEN', 'The authentication token is missing required claims.');
    return { clerkId: claims.sub, email: email.toLowerCase() };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'INVALID_TOKEN', 'The authentication token could not be verified.');
  }
}

async function syncUser(identity: { clerkId: string; email: string }, env: Env): Promise<AuthUser> {
  const bootstrapRole: Role = organizerIds(env).has(identity.clerkId) ? 'ORGANIZER' : 'CUSTOMER';
  await env.DB.prepare(
    `INSERT INTO users (clerk_id, email, role) VALUES (?, ?, ?)
     ON CONFLICT(clerk_id) DO UPDATE SET email = excluded.email`,
  ).bind(identity.clerkId, identity.email, bootstrapRole).run();
  const user = await env.DB.prepare('SELECT clerk_id, email, role FROM users WHERE clerk_id = ?').bind(identity.clerkId).first<{ clerk_id: string; email: string; role: Role }>();
  if (!user) throw new AppError(500, 'USER_SYNC_FAILED', 'Unable to prepare the user profile.');
  return { clerkId: user.clerk_id, email: user.email, role: user.role };
}

export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next): Promise<void> {
  const identity = await verifyIdentity(c.req.header('Authorization'), c.env);
  c.set('user', await syncUser(identity, c.env));
  await next();
}

export function requireRole(...roles: Role[]) {
  return async (c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next): Promise<void> => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) throw new AppError(403, 'FORBIDDEN', 'Your role cannot perform this action.');
    await next();
  };
}

export function currentUser(c: Context): AuthUser {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
  return user;
}
