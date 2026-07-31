import { relations } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';

/**
 * An organization is a league. This is the tenant boundary: every other
 * tenant-scoped table carries `org_id` and is protected by a row-level
 * security policy comparing it to a transaction-local setting.
 *
 * `organizations` and `org_domains` are *routing* tables — they must be
 * readable before we know which league a request belongs to, because resolving
 * a hostname to a league is itself a query against them. They hold nothing
 * sensitive: a league's name and hostname are public by definition, since they
 * are how the public reaches the site.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    // Uniqueness is enforced by a partial index below, not here — a plain
    // UNIQUE would count soft-deleted rows and burn the slug forever.
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    /** IANA zone. Every kickoff time is stored UTC and rendered in this. */
    timezone: text('timezone').notNull().default('America/Vancouver'),
    /** Per-league theming seed, consumed by the design system's token layer. */
    theme: jsonb('theme').notNull().default({}),
    settings: jsonb('settings').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    liveUnique('organizations_slug_unique', t.slug),
    index('organizations_slug_idx').on(t.slug),
  ],
);

/**
 * Each league gets its own website, so the league is resolved from the request
 * Host header. One league may hold several hostnames — apex plus www, or a
 * legacy domain kept alive through a cutover — exactly one of which is primary.
 */
export const orgDomains = pgTable(
  'org_domains',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    // Partial: retiring a domain must free it for reuse, including by another
    // league taking over a hostname after a merger.
    liveUnique('org_domains_hostname_unique', t.hostname),
    index('org_domains_hostname_idx').on(t.hostname),
    index('org_domains_org_idx').on(t.orgId),
  ],
);

/**
 * Append-only audit trail.
 *
 * Leagues argue about who changed what: a rescheduled fixture, an overturned
 * suspension, a roster edited after a deadline. "The system says so" is only an
 * answer if the system actually recorded it — and only trustworthy if the
 * application could not have rewritten it afterwards.
 *
 * Enforced in the database: this table gets SELECT and INSERT policies and no
 * UPDATE or DELETE policy at all, so PostgreSQL refuses to change or remove a
 * row. See src/db/policies.ts.
 *
 * `orgId` is nullable because some events are genuinely platform-level.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorUserId: text('actor_user_id'),
    /** Dotted, e.g. "club.create", "result.correct", "sanction.impose". */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    /** Why, in the actor's words. Required for corrections and overrides. */
    reason: text('reason'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorUserId),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  domains: many(orgDomains),
}));

export const orgDomainsRelations = relations(orgDomains, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgDomains.orgId],
    references: [organizations.id],
  }),
}));
