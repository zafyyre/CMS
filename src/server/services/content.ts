import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import { articles, documents, persons } from '@/db/schema';
import { slugify } from '@/lib/slug';
import { recordAudit } from '@/server/audit/record';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { NotFoundError, requireText } from './errors';

/**
 * Reading and writing the league's published content.
 *
 * The read path's job is to publish only what is actually meant to be public:
 * a draft has no `publishedAt`, a scheduled post has one in the future, and an
 * expired classified has an `expiresAt` in the past. All three are excluded by
 * the same predicate, in one place, because "the draft went live early" is the
 * kind of mistake that only becomes visible once it has.
 */

export type ArticleKind = 'NEWS' | 'NOTICE' | 'WEEKLY_REPORT';

export interface ArticleSummary {
  id: string;
  kind: ArticleKind;
  title: string;
  slug: string;
  summary: string | null;
  publishedAt: Date | null;
  isPinned: boolean;
  authorName: string | null;
}

export interface ArticleDetail extends ArticleSummary {
  body: string;
}

/**
 * Published, not scheduled, not expired.
 *
 * `at` is a parameter rather than `now()` so a preview can ask "what will be
 * public on Sunday" and so the tests need no clock control.
 */
const isLive = (at: Date) =>
  and(
    isNull(articles.deletedAt),
    sql`${articles.publishedAt} IS NOT NULL`,
    lte(articles.publishedAt, at),
    or(isNull(articles.expiresAt), sql`${articles.expiresAt} > ${at}`),
  );

export async function listArticles(
  orgId: OrgId,
  options: { kind?: ArticleKind; limit?: number; at?: Date } = {},
): Promise<ArticleSummary[]> {
  const at = options.at ?? new Date();

  return withOrg(orgId, async (tx) => {
    const conditions = [isLive(at)];
    if (options.kind) conditions.push(eq(articles.kind, options.kind));

    const rows = await tx
      .select({
        id: articles.id,
        kind: articles.kind,
        title: articles.title,
        slug: articles.slug,
        summary: articles.summary,
        publishedAt: articles.publishedAt,
        isPinned: articles.isPinned,
        authorName: persons.displayName,
      })
      .from(articles)
      .leftJoin(persons, eq(articles.authorPersonId, persons.id))
      .where(and(...conditions))
      // Pinned first, then newest. A notice about a cancelled weekend has to
      // outrank a fortnight-old report whatever the dates say.
      .orderBy(desc(articles.isPinned), desc(articles.publishedAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({ ...row, kind: row.kind as ArticleKind }));
  });
}

export async function getArticleBySlug(
  orgId: OrgId,
  slug: string,
  at: Date = new Date(),
): Promise<ArticleDetail | null> {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: articles.id,
        kind: articles.kind,
        title: articles.title,
        slug: articles.slug,
        summary: articles.summary,
        body: articles.body,
        publishedAt: articles.publishedAt,
        isPinned: articles.isPinned,
        authorName: persons.displayName,
      })
      .from(articles)
      .leftJoin(persons, eq(articles.authorPersonId, persons.id))
      .where(and(eq(articles.slug, slug), isLive(at)));

    return row ? { ...row, kind: row.kind as ArticleKind } : null;
  });
}

export interface DocumentSummary {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  category: string | null;
  url: string;
  sizeLabel: string | null;
  publishedAt: Date | null;
}

export async function listDocuments(
  orgId: OrgId,
  at: Date = new Date(),
): Promise<DocumentSummary[]> {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: documents.id,
        title: documents.title,
        slug: documents.slug,
        description: documents.description,
        category: documents.category,
        url: documents.url,
        sizeLabel: documents.sizeLabel,
        publishedAt: documents.publishedAt,
      })
      .from(documents)
      .where(
        and(
          isNull(documents.deletedAt),
          sql`${documents.publishedAt} IS NOT NULL`,
          lte(documents.publishedAt, at),
        ),
      )
      .orderBy(asc(documents.category), asc(documents.sortOrder), asc(documents.title)),
  );
}

// --- writes ------------------------------------------------------------------

export interface CreateArticleInput {
  kind?: ArticleKind;
  title: string;
  body: string;
  summary?: string | null;
  publishedAt?: Date | null;
  isPinned?: boolean;
  expiresAt?: Date | null;
}

/**
 * Authorized as `league`, the organization record itself.
 *
 * Publishing on the league's behalf is speaking for it, which is exactly the
 * authority `league: READ_UPDATE` describes — and it means a club admin cannot
 * post to the league's front page, which they otherwise could if this borrowed
 * a resource type they happen to hold.
 */
export async function createArticle(
  principal: Principal,
  input: CreateArticleInput,
): Promise<{ id: string; slug: string }> {
  assertCan(principal, 'update', { type: 'league' });

  const title = requireText(input.title, 'title');
  const body = requireText(input.body, 'body');

  return withOrg(principal.orgId, async (tx) => {
    const [created] = await tx
      .insert(articles)
      .values({
        orgId: principal.orgId,
        kind: input.kind ?? 'NEWS',
        title,
        slug: slugify(title),
        summary: input.summary ?? null,
        body,
        publishedAt: input.publishedAt ?? null,
        isPinned: input.isPinned ?? false,
        expiresAt: input.expiresAt ?? null,
        authorPersonId: principal.personId,
      })
      .returning({ id: articles.id, slug: articles.slug });

    if (!created) throw new Error('article insert returned no row');

    await recordAudit(tx, principal, {
      action: 'article.create',
      entityType: 'article',
      entityId: created.id,
      after: { title, kind: input.kind ?? 'NEWS', published: input.publishedAt !== null },
    });

    return created;
  });
}

export interface CreateDocumentInput {
  title: string;
  url: string;
  description?: string | null;
  category?: string | null;
  sizeLabel?: string | null;
  sortOrder?: number;
  publishedAt?: Date | null;
}

export async function createDocument(
  principal: Principal,
  input: CreateDocumentInput,
): Promise<{ id: string }> {
  assertCan(principal, 'update', { type: 'league' });

  const title = requireText(input.title, 'title');
  const url = requireText(input.url, 'url');

  // Checked here as well as by the database constraint, so the operator gets a
  // sentence rather than a constraint violation.
  if (!/^https?:\/\//i.test(url)) {
    throw new NotFoundError('document url', 'must start with http:// or https://');
  }

  return withOrg(principal.orgId, async (tx) => {
    const [created] = await tx
      .insert(documents)
      .values({
        orgId: principal.orgId,
        title,
        slug: slugify(title),
        description: input.description ?? null,
        category: input.category ?? null,
        url,
        sizeLabel: input.sizeLabel ?? null,
        sortOrder: input.sortOrder ?? 0,
        publishedAt: input.publishedAt ?? new Date(),
      })
      .returning({ id: documents.id });

    if (!created) throw new Error('document insert returned no row');

    await recordAudit(tx, principal, {
      action: 'document.create',
      entityType: 'document',
      entityId: created.id,
      after: { title, url, category: input.category ?? null },
    });

    return created;
  });
}
