/**
 * Schema barrel.
 *
 * drizzle.config.ts points here, so every table must be reachable from this
 * file or it will not appear in a generated migration.
 */
export * from './schema/enums';
export * from './schema/tenancy';
export * from './schema/identity';
export * from './schema/competition';
export * from './schema/participation';
