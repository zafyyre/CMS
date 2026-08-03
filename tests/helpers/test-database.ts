export const TEST_DATABASE_NAME = 'cms_test';

/**
 * Prevent test setup from treating the TEST_ environment-variable prefix as a
 * safety boundary. The destructive fixture connection must target this exact
 * disposable database.
 */
export function assertTestDatabaseUrl(variableName: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL connection URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variableName} must be a PostgreSQL connection URL`);
  }

  const databaseName = decodeURIComponent(url.pathname).replace(/^\//, '');
  assertTestDatabaseName(databaseName, variableName);
}

/** Verify the database identity reported by PostgreSQL immediately before truncation. */
export function assertTestDatabaseName(databaseName: string | undefined, source = 'database'): void {
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(
      `${source} must target the dedicated ${TEST_DATABASE_NAME} database; refusing destructive test setup.`,
    );
  }
}
