import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/server/authz/can';
import {
  createArticle,
  createDocument,
  getArticleBySlug,
  listArticles,
  listDocuments,
} from '@/server/services/content';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  truncateAll,
} from '../helpers/fixtures';
import { clubScoped, leagueAdmin, orgScoped, principalFor } from '../helpers/principals';

/**
 * Publishing.
 *
 * The property under test throughout: nothing reaches the public that was not
 * meant to. A draft, a post scheduled for next month and an expired classified
 * are three different states and all three must be invisible — and "the draft
 * went live early" is a mistake that is only ever noticed after it happens.
 */

let league: LeagueFixture;

beforeEach(async () => {
  await truncateAll();
  league = await createLeagueFixture('alpha');
});

afterAll(async () => {
  await closeFixtures();
});

const admin = () => leagueAdmin(league);
const DAY = 86_400_000;

async function catchError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('what the public can see', () => {
  it('shows a published article', async () => {
    await createArticle(admin(), {
      title: 'Season starts Saturday',
      body: 'All divisions begin this weekend.',
      publishedAt: new Date(Date.now() - DAY),
    });

    const articles = await listArticles(league.orgId);
    expect(articles).toHaveLength(1);
    expect(articles[0]?.title).toBe('Season starts Saturday');
  });

  it('hides a draft', async () => {
    // No publishedAt at all. Different from scheduled, and equally invisible.
    await createArticle(admin(), { title: 'Half-written', body: 'Not ready.' });
    expect(await listArticles(league.orgId)).toHaveLength(0);
  });

  it('hides a post scheduled for later, then shows it when the date arrives', async () => {
    const publishedAt = new Date(Date.now() + 7 * DAY);
    await createArticle(admin(), { title: 'Next week', body: 'Later.', publishedAt });

    expect(await listArticles(league.orgId)).toHaveLength(0);
    // `at` is a parameter rather than the clock, so this needs no time travel.
    expect(await listArticles(league.orgId, { at: new Date(Date.now() + 8 * DAY) })).toHaveLength(1);
  });

  it('hides an expired classified', async () => {
    await createArticle(admin(), {
      kind: 'NOTICE',
      title: 'Referees wanted',
      body: 'Contact the assignor.',
      publishedAt: new Date(Date.now() - 30 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await listArticles(league.orgId)).toHaveLength(0);
  });

  it('applies the same rules to a single article by slug', async () => {
    // The list page and the article page must agree, or a draft is reachable
    // by anyone who guesses or is sent the URL.
    const draft = await createArticle(admin(), { title: 'Unreleased', body: 'Secret.' });
    expect(await getArticleBySlug(league.orgId, draft.slug)).toBeNull();
  });

  it('puts a pinned notice above a newer one', async () => {
    await createArticle(admin(), {
      title: 'Newer but ordinary',
      body: 'x',
      publishedAt: new Date(Date.now() - DAY),
    });
    await createArticle(admin(), {
      title: 'Older but pinned',
      body: 'x',
      publishedAt: new Date(Date.now() - 10 * DAY),
      isPinned: true,
    });

    const articles = await listArticles(league.orgId);
    expect(articles[0]?.title).toBe('Older but pinned');
  });

  it('filters by kind', async () => {
    const publishedAt = new Date(Date.now() - DAY);
    await createArticle(admin(), { kind: 'NEWS', title: 'A', body: 'x', publishedAt });
    await createArticle(admin(), { kind: 'WEEKLY_REPORT', title: 'B', body: 'x', publishedAt });

    expect(await listArticles(league.orgId, { kind: 'WEEKLY_REPORT' })).toHaveLength(1);
    expect(await listArticles(league.orgId)).toHaveLength(2);
  });
});

describe('documents', () => {
  it('publishes a document with its category and size', async () => {
    await createDocument(admin(), {
      title: 'Rules and Regulations',
      url: 'https://example.invalid/rules.pdf',
      category: 'Rules',
      sizeLabel: '1.2 MB',
    });

    const documents = await listDocuments(league.orgId);
    expect(documents[0]).toMatchObject({ title: 'Rules and Regulations', sizeLabel: '1.2 MB' });
  });

  it('refuses a URL that is not http or https', async () => {
    // A `javascript:` URL rendered into an href is a stored XSS on the
    // league's own site.
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://example.invalid/x']) {
      expect(await catchError(() => createDocument(admin(), { title: 'Bad', url }))).toBeDefined();
    }
    expect(await listDocuments(league.orgId)).toHaveLength(0);
  });
});

describe('who may publish', () => {
  it('lets the league office publish', async () => {
    const created = await createArticle(admin(), { title: 'Official', body: 'x' });
    expect(created.id).toBeDefined();
  });

  it('refuses a club administrator', async () => {
    // Publishing on the league's front page is speaking for the league. A club
    // admin holds authority over their own club, not over its voice.
    const clubAdmin = principalFor(league, clubScoped('CLUB_ADMIN', league.clubId));
    expect(await catchError(() => createArticle(clubAdmin, { title: 'Ours', body: 'x' }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a player', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    expect(await catchError(() => createArticle(player, { title: 'Mine', body: 'x' }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses an administrator without a second factor', async () => {
    const unenrolled = principalFor(league, orgScoped('LEAGUE_ADMIN'), { mfaSatisfied: false });
    expect(
      await catchError(() => createArticle(unenrolled, { title: 'No factor', body: 'x' })),
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe('leagues cannot read each other\'s content', () => {
  it('keeps articles and documents inside their own league', async () => {
    const bravo = await createLeagueFixture('bravo');

    await createArticle(admin(), {
      title: 'Alpha only',
      body: 'x',
      publishedAt: new Date(Date.now() - DAY),
    });
    await createDocument(admin(), { title: 'Alpha rules', url: 'https://example.invalid/a.pdf' });

    expect(await listArticles(bravo.orgId)).toHaveLength(0);
    expect(await listDocuments(bravo.orgId)).toHaveLength(0);
    expect(await getArticleBySlug(bravo.orgId, 'alpha-only')).toBeNull();
  });
});
