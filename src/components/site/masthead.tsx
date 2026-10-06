'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { buttonClass } from '@/components/ui/button';
import styles from './masthead.module.css';
import { currentSection, type Section } from './sections';

export interface HeaderAccount {
  href: string;
  label: string;
  /** A small role glyph shown before the label; decorative. */
  icon: string;
}

interface MastheadProps {
  leagueName: string;
  monogram: string;
  tagline: string | null;
  /** `null` when signed out. */
  account: HeaderAccount | null;
  sections: readonly Section[];
}

/**
 * The header on every page: the league's identity, a club search, the
 * account control, and the section navigation — a scrolling row on wide
 * screens, a panel behind a menu button below 1025px.
 *
 * A client component because the menu has state, but everything it shows is
 * passed in by the root layout, which resolves the league and the signed-in
 * person on the server.
 */
export function Masthead({ leagueName, monogram, tagline, account, sections }: MastheadProps) {
  const pathname = usePathname();
  // The menu remembers WHICH PAGE it was opened on and is closed the moment
  // the page changes — by a link, back and forward, or the search form. The
  // clearing happens during render rather than in an effect, so the new page
  // never paints with the menu open. Comparing alone is not enough: going
  // back to the page it was left open on would reopen it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  if (openOn !== null && openOn !== pathname) setOpenOn(null);
  const open = openOn === pathname;
  const setOpen = (value: boolean) => setOpenOn(value ? pathname : null);
  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const current = currentSection(pathname, sections);

  // While open: Escape or a tap anywhere outside the menu closes it, the page
  // underneath stops scrolling, and widening the window past the menu
  // breakpoint cannot leave it stuck open. Outside taps are caught on the
  // document rather than only the backdrop, because the header bar sits above
  // the backdrop; the toggle is excluded since it flips the menu itself.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenOn(null);
        toggleRef.current?.focus();
      }
    };
    const onTap = (event: MouseEvent) => {
      const target = event.target as Node;
      if (navRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setOpenOn(null);
    };
    const wide = window.matchMedia('(min-width: 1025px)');
    const onWide = () => {
      if (wide.matches) setOpenOn(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onTap);
    wide.addEventListener('change', onWide);
    document.documentElement.dataset.menuOpen = '';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onTap);
      wide.removeEventListener('change', onWide);
      delete document.documentElement.dataset.menuOpen;
    };
  }, [open]);

  // The header's height feeds two things: the open menu is capped to the
  // space below it, and in-page jumps (the skip link, a #fragment) stop below
  // it rather than underneath it — see globals.css. It changes when a long
  // league name wraps on a narrow phone and when the section row folds into
  // the menu, so measure it directly each time the menu opens and then
  // whenever it resizes.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return undefined;
    const measure = () => {
      const height = Math.round(header.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--masthead-height', `${height}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [open]);

  // The glyph and the label as ONE run of text, exactly as the design sets
  // it: the pill is a flex container with a gap, so a glyph in an element of
  // its own would sit a gap from the label instead of a space, and even an
  // inline wrapper shifts the text by a fraction of a pixel. The link is named
  // by the label alone (`aria-label`), so a screen reader skips the glyph.
  const accountText = account ? `${account.icon} ${account.label}` : null;

  return (
    <>
      <header className={styles.masthead} ref={headerRef}>
        <div className={`${styles.frame} ${styles.bar}`}>
          <Link href="/" className={styles.identity}>
            <span className={styles.monogram} aria-hidden="true">
              {monogram}
            </span>
            <span className={styles.names}>
              <span className={styles.leagueName}>{leagueName}</span>
              {tagline ? <span className={styles.tagline}>{tagline}</span> : null}
            </span>
          </Link>

          <div className={styles.spacer} />

          <form className={styles.search} action="/clubs" method="get" role="search">
            <span aria-hidden="true">🔍</span>
            <input
              className={styles.searchInput}
              type="text"
              name="q"
              placeholder="Search clubs…"
              aria-label="Search clubs"
              enterKeyHint="search"
              autoComplete="off"
            />
          </form>

          {account ? (
            <div className={styles.accountArea}>
              <Link href={account.href} className={styles.accountPill} aria-label={account.label}>
                {accountText}
              </Link>
              <SignOutButton className={buttonClass({ size: 'small', className: styles.signOut })} />
            </div>
          ) : (
            <Link href="/sign-in" className={styles.accountPill}>
              Sign in
            </Link>
          )}

          <button
            type="button"
            ref={toggleRef}
            className={styles.menuButton}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="site-sections"
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            <span aria-hidden="true">{open ? '✕' : '☰'}</span>
          </button>
        </div>

        <nav
          id="site-sections"
          ref={navRef}
          aria-label="Main"
          className={`${styles.sections}${open ? ` ${styles.expanded}` : ''}`}
        >
          <div className={styles.frame}>
            {/* A tapped link or button closes the menu — even the link for the
                current page, which changes no route, and Sign out, which
                changes none until the session is gone. Blank space between
                items is part of the panel, so like its padding it keeps the
                menu open. */}
            <ul
              className={styles.list}
              onClick={(event) => {
                if ((event.target as Element).closest('a, button')) setOpen(false);
              }}
            >
              {sections.map((section) => (
                <li key={section.href} className={styles.item}>
                  <Link
                    href={section.href}
                    className={`${styles.link}${current === section.href ? ` ${styles.current}` : ''}`}
                    aria-current={current === section.href ? 'page' : undefined}
                  >
                    {section.label}
                  </Link>
                </li>
              ))}
              {account ? (
                <>
                  <li className={`${styles.item} ${styles.menuAccount}`}>
                    <Link href={account.href} className={styles.link} aria-label={account.label}>
                      {accountText}
                    </Link>
                  </li>
                  <li className={`${styles.item} ${styles.menuAccount}`}>
                    <SignOutButton className={styles.link} />
                  </li>
                </>
              ) : (
                <li className={`${styles.item} ${styles.menuAccount}`}>
                  <Link href="/sign-in" className={styles.link}>
                    Sign in
                  </Link>
                </li>
              )}
            </ul>
          </div>
        </nav>
      </header>

      {/* Dims the page behind the open menu and takes the tap that closes it.
          Its own click handler as well as the document's: iOS Safari only
          delivers a tap on a plain element to an element that listens for it. */}
      <div
        className={`${styles.scrim}${open ? ` ${styles.expanded}` : ''}`}
        aria-hidden="true"
        onClick={() => setOpenOn(null)}
      />
    </>
  );
}
