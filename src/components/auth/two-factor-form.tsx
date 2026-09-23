'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { twoFactor } from '@/lib/auth-client';

/**
 * TOTP verification, with backup codes as the escape hatch.
 *
 * The backup-code path is not optional politeness. A league administrator who
 * loses their phone and cannot sign in is a league administrator who asks
 * somebody to turn MFA off — and the request will be granted, because the
 * season does not stop. Making recovery a normal, documented path is what stops
 * the second factor being disabled the first time it is inconvenient.
 *
 * `inputMode="numeric"` and `autoComplete="one-time-code"` between them mean a
 * phone shows a number pad and iOS offers the code from the notification.
 */
export function TwoFactorForm({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = useBackup
      ? await twoFactor.verifyBackupCode({ code })
      : await twoFactor.verifyTotp({ code, trustDevice });

    if (result.error) {
      setError(
        useBackup
          ? 'That backup code is not valid, or has already been used.'
          : 'That code is not valid. Codes expire after thirty seconds — try the next one.',
      );
      setPending(false);
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
        <label htmlFor="code" className="block text-sm font-medium">
          {useBackup ? 'Backup code' : 'Six-digit code'}
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(e) => setCode(e.target.value.trim())}
          className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm tabular-nums"
        />
      </div>

      {!useBackup ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Remember this device for 60 days
            <span className="block text-xs text-muted-foreground">
              Only on a device nobody else uses.
            </span>
          </span>
        </label>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-60"
      >
        {pending ? 'Verifying…' : 'Verify'}
      </button>

      <button
        type="button"
        onClick={() => {
          setUseBackup(!useBackup);
          setCode('');
          setError(null);
        }}
        className="w-full text-sm underline"
      >
        {useBackup ? 'Use an authenticator code instead' : 'Use a backup code instead'}
      </button>
    </form>
  );
}
