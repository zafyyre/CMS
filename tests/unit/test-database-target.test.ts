import { describe, expect, it } from 'vitest';
import {
  assertTestDatabaseName,
  assertTestDatabaseUrl,
} from '../helpers/test-database';

describe('destructive test database boundary', () => {
  it('accepts the dedicated test database', () => {
    expect(() =>
      assertTestDatabaseUrl('TEST_SEED_DATABASE_URL', 'postgresql://postgres:secret@localhost:5433/cms_test'),
    ).not.toThrow();
    expect(() => assertTestDatabaseName('cms_test')).not.toThrow();
  });

  it('rejects a non-test database before destructive setup', () => {
    expect(() =>
      assertTestDatabaseUrl('TEST_SEED_DATABASE_URL', 'postgresql://postgres:secret@localhost:5433/cms'),
    ).toThrow(/cms_test/);
    expect(() => assertTestDatabaseName('cms')).toThrow(/cms_test/);
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() =>
      assertTestDatabaseUrl('TEST_SEED_DATABASE_URL', 'mysql://root:secret@localhost:3306/cms_test'),
    ).toThrow(/PostgreSQL/);
  });
});
