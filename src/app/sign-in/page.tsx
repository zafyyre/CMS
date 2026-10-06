import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/sign-in-form';
import { PageFrame } from '@/components/site/page-frame';
import { safeNext } from '@/lib/safe-next';
import { getPrincipal } from '@/server/auth/principal';

/**
 * Sign in.
 *
 * The screen that has been missing since Phase 1: better-auth, the session
 * tables, the TOTP gate and the whole permission matrix were all built and
 * tested with no way for a human to actually log in.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in',
  // A sign-in page in a search index is noise at best.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { next } = await searchParams;

  // Already signed in: nothing to do here.
  const principal = await getPrincipal();
  if (principal) redirect(safeNext(next));

  return (
    <PageFrame measure="form">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        For club officials, referees and league staff. The public pages need no account.
      </p>

      <SignInForm next={safeNext(next)} />
    </PageFrame>
  );
}
