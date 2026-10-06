import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { PageFrame } from '@/components/site/page-frame';
import { StatusPill } from '@/components/status-pill';
import { auth } from '@/server/auth';
import { getPrincipal } from '@/server/auth/principal';
import { adminSections } from '@/server/authz/admin-sections';
import { principalRequiresMfa } from '@/server/authz/roles';

/**
 * The gate in front of every admin screen.
 *
 * Worth being explicit about what this layout is and is NOT. It is a
 * convenience: it stops a signed-out visitor seeing a page full of empty
 * forms, and it hides links to things the caller cannot do. It is emphatically
 * NOT the security boundary — a layout runs only when Next decides to render
 * a page, and a Server Action reached by a direct POST never renders anything.
 *
 * The boundary is three layers deeper: every action re-establishes the
 * principal, every service consults the permission matrix, and PostgreSQL
 * scopes the query to the league regardless. This is the doormat, not the lock.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in?next=/admin');

  const session = await auth.api.getSession({ headers: await headers() });

  // Roles, not MFA: see adminSections for why navigation ignores enrolment.
  const sections = adminSections(principal);
  const canManageFixtures = sections.fixtures;
  const canManageVenues = sections.venues;
  const canImport = sections.imports;
  const canDoAnything = sections.any;

  const mfaOutstanding = principalRequiresMfa(principal) && !session?.user.twoFactorEnabled;

  return (
    // Grows to fill <body>, so the site footer sits at the bottom of a short
    // admin page. `main { flex: 1 }` cannot do it here: this <main> is not a
    // direct child of <body>, this wrapper is.
    <div className="flex flex-1 flex-col">
      {/* A plain block, not a <header>: the site header above is this page's
          banner, and a second banner landmark confuses screen readers. The
          league link and Sign out that used to sit here now live in the site
          header; the account link stays, because the header sends admins to
          /admin and this is their way to /account. */}
      <div className="border-b">
        <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-6 gap-y-2 px-(--page-gutter) py-3">
          <nav aria-label="Admin" className="flex flex-wrap gap-4 text-sm">
            <Link href="/admin" className="hover:underline">
              Overview
            </Link>
            {canManageFixtures ? (
              <Link href="/admin/fixtures" className="hover:underline">
                Fixtures
              </Link>
            ) : null}
            {canManageVenues ? (
              <Link href="/admin/venues" className="hover:underline">
                Venues
              </Link>
            ) : null}
            {canImport ? (
              <Link href="/admin/import" className="hover:underline">
                Import
              </Link>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Link href="/account" className="text-sm hover:underline">
              {session?.user.name ?? 'Account'}
            </Link>
          </div>
        </div>
      </div>

      {mfaOutstanding ? (
        <div className="border-b border-status-caution/40 bg-status-caution-bg/40">
          <div className="mx-auto flex max-w-page flex-wrap items-center gap-3 px-(--page-gutter) py-3 text-sm">
            <StatusPill tone="caution">Second factor not enrolled</StatusPill>
            <span>
              Your roles cannot write anything until you enrol. Every button below will refuse.
            </span>
            <Link href="/account" className="underline">
              Enrol now
            </Link>
          </div>
        </div>
      ) : null}

      <PageFrame>
        {canDoAnything ? (
          children
        ) : (
          <div className="rounded-lg border p-6">
            <h1 className="text-lg font-medium">Nothing to administer</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You are signed in, but you hold no role in this league that grants access to these
              screens. Your{' '}
              <Link href="/account" className="underline">
                account page
              </Link>{' '}
              lists what you do hold.
            </p>
          </div>
        )}
      </PageFrame>
    </div>
  );
}
