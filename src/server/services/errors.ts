/**
 * Errors the service layer raises, kept in one place so a route handler can
 * map them to status codes without importing half the domain.
 *
 * `ForbiddenError` is deliberately NOT here: it belongs to `src/server/authz`,
 * because an authorization failure is a different category of event from a
 * malformed input, and the two should not become interchangeable by sitting in
 * the same file.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Raised when a row is not visible in the current league.
 *
 * Note what this deliberately does not distinguish: a row that does not exist
 * and a row belonging to another league produce the identical error, because
 * row-level security returns nothing in both cases. That is the right
 * behaviour — a different message would confirm the existence of another
 * league's data to someone probing ids.
 */
export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`No ${entity} with id ${id} in this league`);
    this.name = 'NotFoundError';
  }
}

export function requireText(value: string | null | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new ValidationError(`${field} is required`);
  return trimmed;
}
