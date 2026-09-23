import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import { articleKindEnum } from './enums';
import { persons } from './identity';
import { organizations } from './tenancy';

/**
 * The things a league PUBLISHES, as distinct from the things it records.
 *
 * The old site has three of these and treats them as three unrelated systems: a
 * Notice Board of classifieds, Weekly Reports sent as bulk email, and a
 * scattering of PDFs under "General Documents". They are one thing — a piece of
 * writing, or a file, with a date and an audience — and modelling them
 * separately is why the constitution is findable and the weekly report is not.
 *
 * Deliberately small. This is not a CMS, and it should not grow into one: a
 * league needs to post a notice and link a rulebook, and everything beyond that
 * belongs to whatever the league already uses to write.
 */

/**
 * A piece of writing: news, a notice-board classified, a weekly report.
 *
 * `publishedAt` in the future is a scheduled post, and the public reads filter
 * on it — so an administrator can write Sunday's report on Friday. Null means
 * a draft, which is different from a post scheduled for later.
 */
export const articles = pgTable(
  'articles',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: articleKindEnum('kind').notNull().default('NEWS'),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    /** One or two sentences for the index page. */
    summary: text('summary'),
    /** Markdown. Rendered as plain text with paragraph breaks — see /news. */
    body: text('body').notNull(),

    /** Null is a draft. A future date is scheduled. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Stays at the top of the index regardless of date. */
    isPinned: boolean('is_pinned').notNull().default(false),
    /** When a classified stops being relevant. Null means it does not. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    authorPersonId: uuid('author_person_id'),
    ...timestamps,
  },
  (t) => [
    unique('articles_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.authorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'articles_author_fk',
    }),
    liveUnique('articles_org_slug_unique', t.orgId, t.slug),
    index('articles_org_published_idx').on(t.orgId, t.publishedAt),
    index('articles_org_kind_idx').on(t.orgId, t.kind),
    check('articles_expiry_after_publication', sql`expires_at IS NULL OR published_at IS NULL OR expires_at > published_at`),
  ],
);

/**
 * A document the league publishes: the constitution, the rulebook, the fine
 * schedule, a registration form.
 *
 * `url` rather than an upload. File storage lands in Phase 8 alongside
 * registration documents, which need presigned uploads and a retention policy
 * because they carry criminal record checks and proof of age. Building a second
 * upload path here, three phases early and with none of that, is how a system
 * ends up with two file stores and one of them unaudited. Until then this
 * points at wherever the league already keeps its PDFs.
 */
export const documents = pgTable(
  'documents',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /** Free text — "Rules", "Registration", "Governance". A tag, not a taxonomy. */
    category: text('category'),
    url: text('url').notNull(),
    /** Shown beside the link, so nobody downloads 40MB on mobile data unaware. */
    sizeLabel: text('size_label'),
    sortOrder: integer('sort_order').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    liveUnique('documents_org_slug_unique', t.orgId, t.slug),
    index('documents_org_category_idx').on(t.orgId, t.category),
    // http/https only. A `javascript:` or `data:` URL rendered into an href is
    // a stored XSS, and this is the cheapest place to make that impossible.
    check('documents_url_is_http', sql`url ~* '^https?://'`),
  ],
);

// --- relations ---------------------------------------------------------------

export const articlesRelations = relations(articles, ({ one }) => ({
  organization: one(organizations, { fields: [articles.orgId], references: [organizations.id] }),
  author: one(persons, { fields: [articles.authorPersonId], references: [persons.id] }),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  organization: one(organizations, { fields: [documents.orgId], references: [organizations.id] }),
}));
