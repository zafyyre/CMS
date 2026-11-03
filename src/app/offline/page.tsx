import Link from 'next/link';
import { PageFrame } from '@/components/site/page-frame';
import { PageHeading } from '@/components/ui/page-heading';

/**
 * What a player sees at a pitch with no signal.
 *
 * Precached by the service worker on install, so it is available precisely
 * when nothing else is. It says what IS available rather than only what is
 * not — the browser's own error page already covers "this did not load", and
 * adds nothing a person standing in a field can act on.
 */
export const metadata = {
  title: 'Offline',
  description: 'You are offline.',
};

export default function OfflinePage() {
  return (
    <PageFrame measure="narrow">
      <PageHeading
        title="You are offline"
        description={
          <>
            This page has not been saved to your phone. Anything you have opened before is
            still available.
          </>
        }
      />

      <ul className="mt-6 space-y-2 text-sm">
        <li>
          <Link href="/standings" className="underline">
            Standings
          </Link>
        </li>
        <li>
          <Link href="/schedule" className="underline">
            Schedule
          </Link>
        </li>
        <li>
          <Link href="/fields" className="underline">
            Field status
          </Link>
        </li>
      </ul>

      <p className="mt-8 text-sm text-muted-foreground">
        Fixtures you have subscribed to are in your phone&rsquo;s calendar and work without a
        connection.
      </p>
    </PageFrame>
  );
}
