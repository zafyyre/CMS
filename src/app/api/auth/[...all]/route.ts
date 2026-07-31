import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/server/auth';

/**
 * better-auth's endpoints: sign-in, sign-up, sign-out, session, and TOTP
 * enrolment and verification. Node runtime, because it reaches PostgreSQL.
 */
export const runtime = 'nodejs';

export const { GET, POST } = toNextJsHandler(auth.handler);
