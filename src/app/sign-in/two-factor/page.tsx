import { TwoFactorForm } from '@/components/auth/two-factor-form';
import { PageFrame } from '@/components/site/page-frame';
import { PageHeading } from '@/components/ui/page-heading';
import { safeNext } from '@/lib/safe-next';

/**
 * The second factor.
 *
 * Reached only when better-auth has verified a password but is WITHHOLDING the
 * session until a TOTP code arrives. That withholding is what makes
 * `session.user.twoFactorEnabled` mean "this factor was satisfied" on the
 * server — which is precisely the assumption `getPrincipal()` encodes as
 * `mfaSatisfied`, and therefore what the permission matrix gates admin writes
 * on. If this page were skippable, that assumption would be false everywhere.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Two-factor authentication',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function TwoFactorPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const destination = safeNext(next);

  return (
    <PageFrame measure="form">
      <PageHeading
        title="Two-factor authentication"
        description="Enter the six-digit code from your authenticator app."
      />

      <TwoFactorForm next={destination} />
    </PageFrame>
  );
}
