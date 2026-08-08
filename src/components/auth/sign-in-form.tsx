'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIn } from '@/lib/auth-client';

/**
 * The sign-in form: an email address or a username, and a password.
 *
 * ── ONE FIELD, NOT TWO ──────────────────────────────────────────────────────
 * There is no "sign in with email / sign in with username" toggle, and no
 * second box. Whether the string contains an `@` is something the form can work
 * out for itself, and it is not a decision worth making a tired volunteer read
 * a label for at eight on a Saturday morning.
 *
 * The routing is a real distinction underneath — better-auth exposes separate
 * endpoints — but that is our problem, not theirs.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Other decisions here that are easy to get wrong and expensive afterwards:
 *
 * - **One error message for every failure.** "No such account" and "wrong
 *   password" read identically, because distinguishing them turns the form into
 *   an oracle for which addresses belong to league officials.
 * - **The submit button disables while in flight**, so a slow connection at a
 *   pitch does not produce three attempts — better-auth allows three sign-ins
 *   per ten seconds, and the fourth is refused.
 * - **Errors are announced.** `role="alert"` means a screen reader hears the
 *   failure rather than the user wondering why nothing happened.
 * - **Autocomplete is `username`**, which is correct for both cases and is what
 *   makes a password manager fill this. A form that fights the password manager
 *   is a form that gets a reused password.
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const trimmed = identifier.trim();
    // An `@` anywhere means they typed an address; usernames cannot contain one.
    const result = trimmed.includes('@')
      ? await signIn.email({ email: trimmed, password, callbackURL: next })
      : await signIn.username({ username: trimmed, password });

    if (result.error) {
      // Deliberately uniform. See the note above.
      setError('That sign-in and password do not match an account.');
      setPending(false);
      return;
    }

    /**
     * The password was right, but a second factor is outstanding — better-auth
     * has withheld the session and is waiting for a code. Carry `next` through
     * so the person still lands where they were going.
     */
    if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      router.push(`/sign-in/two-factor?next=${encodeURIComponent(next)}`);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-status-negative/40 bg-status-negative-bg/40 px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor="identifier" className="block text-sm font-medium">
          Email or username
        </label>
        <input
          id="identifier"
          name="identifier"
          // `text`, not `email`: the browser would otherwise refuse to submit a
          // perfectly valid username for failing its own address validation.
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
