'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { twoFactor } from '@/lib/auth-client';

/**
 * TOTP enrolment.
 *
 * Three details that decide whether the second factor survives contact with a
 * volunteer league committee:
 *
 * 1. **The secret is shown as text as well as a URI.** Not every phone can
 *    scan, and a committee member on a desktop with a hardware token needs to
 *    type it. Hiding it behind a QR code makes enrolment impossible for them.
 * 2. **Backup codes are shown ONCE and the user must confirm they have saved
 *    them.** They cannot be recovered afterwards. A user who skips past this
 *    screen is a user who will eventually be locked out, and the fix at that
 *    point is an administrator turning MFA off — which defeats it entirely.
 * 3. **Enrolment requires the password again.** Otherwise anyone who walks up
 *    to an unlocked laptop can bind their own authenticator to the account and
 *    lock the owner out.
 */
export function EnrolTwoFactor({ enrolled }: { enrolled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function begin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await twoFactor.enable({ password });
    if (result.error || !result.data) {
      /**
       * Distinguish "wrong password" from everything else.
       *
       * Collapsing every failure into "that password is not correct" sent me
       * looking for a password bug while the actual cause was a missing
       * database column — and it would send a league administrator to reset a
       * password that was never wrong. A 401 or 403 is a credential problem; a
       * 500 is ours, and should say so.
       */
      const status = result.error?.status;
      setError(
        status === 401 || status === 403
          ? 'That password is not correct.'
          : `Two-factor setup failed${result.error?.message ? `: ${result.error.message}` : ''}. This is a problem on our side, not with your password.`,
      );
      setPending(false);
      return;
    }

    setTotpUri(result.data.totpURI);
    setBackupCodes(result.data.backupCodes);
    setPassword('');
    setPending(false);
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await twoFactor.verifyTotp({ code });
    if (result.error) {
      setError('That code is not valid. Codes change every thirty seconds.');
      setPending(false);
      return;
    }

    setTotpUri(null);
    setBackupCodes(null);
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await twoFactor.disable({ password });
    if (result.error) {
      setError('That password is not correct.');
      setPending(false);
      return;
    }
    setPassword('');
    setPending(false);
    router.refresh();
  }

  if (enrolled && !totpUri) {
    return (
      <form onSubmit={disable} className="mt-4 space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-status-negative">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Your account asks for a code from your authenticator app every time you sign in on a
          new device.
        </p>
        <details>
          <summary className="cursor-pointer text-sm underline">Turn it off</summary>
          <div className="mt-3 space-y-3">
            <label htmlFor="disable-password" className="block text-sm font-medium">
              Confirm your password
            </label>
            <input
              id="disable-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={pending}
              className="block rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
            >
              {pending ? 'Working…' : 'Turn off two-factor authentication'}
            </button>
          </div>
        </details>
      </form>
    );
  }

  if (totpUri && backupCodes) {
    const secret = new URL(totpUri).searchParams.get('secret') ?? '';

    return (
      <div className="mt-4 space-y-6">
        <div>
          <h3 className="text-sm font-medium">1. Add this to your authenticator app</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Type this key into Google Authenticator, 1Password, Authy or similar.
          </p>
          <code className="mt-2 block break-all rounded-lg border px-3 py-2 font-mono text-sm">
            {secret}
          </code>
        </div>

        <div>
          <h3 className="text-sm font-medium">2. Save these backup codes</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Each works once, if you lose your phone.{' '}
            <strong className="font-medium text-foreground">
              They are shown now and never again.
            </strong>
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-2 rounded-lg border p-3 font-mono text-sm">
            {backupCodes.map((backup) => (
              <li key={backup}>{backup}</li>
            ))}
          </ul>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="mt-0.5"
            />
            <span>I have saved these codes somewhere I can reach without my phone.</span>
          </label>
        </div>

        <form onSubmit={confirm} className="space-y-3">
          <h3 className="text-sm font-medium">3. Confirm with a code</h3>
          {error ? (
            <p role="alert" className="text-sm text-status-negative">
              {error}
            </p>
          ) : null}
          <input
            id="enrol-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Six-digit code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
            className="w-full max-w-sm rounded-lg border px-3 py-2 font-mono text-sm tabular-nums"
          />
          <button
            type="submit"
            // Cannot finish without acknowledging the backup codes. See above.
            disabled={pending || !saved}
            className="block rounded-lg border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-60"
          >
            {pending ? 'Verifying…' : 'Finish enrolment'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={begin} className="mt-4 space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-status-negative">
          {error}
        </p>
      ) : null}
      <label htmlFor="enrol-password" className="block text-sm font-medium">
        Confirm your password to begin
      </label>
      <input
        id="enrol-password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="block rounded-lg border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-60"
      >
        {pending ? 'Working…' : 'Set up two-factor authentication'}
      </button>
    </form>
  );
}
