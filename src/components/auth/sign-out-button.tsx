'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signOut } from '@/lib/auth-client';

/**
 * Sign out.
 *
 * A button in a form rather than a link, because a GET that destroys a session
 * is a session any `<img src>` on any page can destroy — and, more mundanely,
 * one that a link prefetcher will destroy for you the moment it warms the page.
 *
 * `router.refresh()` after the redirect matters: every page here is a server
 * component, so without it the previous user's rendered output stays on screen
 * until something else forces a re-render.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        await signOut();
        router.push('/');
        router.refresh();
      }}
    >
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border px-3 py-2 text-sm hover:border-foreground disabled:opacity-60"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </form>
  );
}
