import type { Role } from './roles';

/**
 * The permission matrix.
 *
 * Written as DATA rather than as branching logic, so it can be read, diffed and
 * exhaustively tested. Every role's full authority is visible in one place —
 * which matters, because "what exactly can a club admin do?" is a question this
 * project will be asked repeatedly for years.
 */

export const ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

export const RESOURCES = [
  'league', // the organization record itself
  'roleGrant',
  'auditLog',
  'person',
  'guardianship',
  'consent',
  'club',
  'team',
  'season',
  'competition', // series, editions, stages, groups
  'entry', // a team's participation
  'registration', // a person's affiliation to a team
  'venue', // grounds and their closures
  'fixture', // a scheduled match, and every change to it
  'result', // a submitted scoreline
  'matchEvent', // goals and cards
  'honour',
] as const;
export type Resource = (typeof RESOURCES)[number];

const ALL: readonly Action[] = ACTIONS;
const READ: readonly Action[] = ['read'];
const CREATE_READ: readonly Action[] = ['create', 'read'];
const READ_UPDATE: readonly Action[] = ['read', 'update'];
const CREATE_READ_UPDATE: readonly Action[] = ['create', 'read', 'update'];

type Grants = Partial<Record<Resource, readonly Action[]>>;

/** What any participant can see without special authority — the public site. */
const PUBLIC_READ: Grants = {
  league: READ,
  club: READ,
  team: READ,
  season: READ,
  competition: READ,
  entry: READ,
  venue: READ,
  fixture: READ,
  result: READ,
  matchEvent: READ,
  honour: READ,
};

export const ROLE_GRANTS: Record<Role, Grants> = {
  /**
   * Platform operator. Short-circuited in `can()` rather than enumerated —
   * listing every permission here would rot the moment a resource is added, and
   * a stale grant list is worse than none.
   */
  PLATFORM_OWNER: {},

  LEAGUE_ADMIN: {
    league: READ_UPDATE, // cannot create or delete leagues; that is operational
    roleGrant: ALL,
    auditLog: READ, // append-only: nobody may update or delete audit rows
    person: ALL,
    guardianship: ALL,
    consent: ALL,
    club: ALL,
    team: ALL,
    season: ALL,
    competition: ALL,
    entry: ALL,
    registration: ALL,
    venue: ALL,
    fixture: ALL,
    result: ALL,
    matchEvent: ALL,
    honour: ALL,
  },

  REGISTRAR: {
    ...PUBLIC_READ,
    club: CREATE_READ_UPDATE,
    team: CREATE_READ_UPDATE,
    person: ALL,
    guardianship: ALL,
    consent: ALL,
    registration: ALL,
    entry: CREATE_READ_UPDATE,
    roleGrant: READ,
    auditLog: READ,
  },

  /**
   * Reads everything, changes nothing here. Their write authority lands in
   * Phase 11 on disciplinary cases, which do not exist yet — deliberately not
   * pre-granted, so the matrix never claims more than the code enforces.
   */
  DISCIPLINE_OFFICER: {
    ...PUBLIC_READ,
    person: READ,
    registration: READ,
    auditLog: READ,
  },

  /** Write authority arrives in Phase 10 with assignments and match reports. */
  REFEREE_ASSIGNOR: {
    ...PUBLIC_READ,
    person: READ,
  },

  /**
   * Scoped to one club. The grants look broad precisely because the scope
   * narrows them — the check in `can()` is what stops a club admin touching
   * another club's teams.
   */
  CLUB_ADMIN: {
    ...PUBLIC_READ,
    club: READ_UPDATE,
    team: CREATE_READ_UPDATE,
    person: CREATE_READ_UPDATE,
    registration: ALL,
    consent: CREATE_READ_UPDATE,
    /**
     * Create, and nothing else. A club may REPORT what it believes the score
     * was — `result_submissions` is append-only, so reporting is the only
     * verb available anyway — but it may not update or delete a submission,
     * its own or anyone else's. Combined with the CLUB scope, that means a
     * club can only report on its own matches, and cannot revise the record
     * afterwards.
     */
    result: CREATE_READ,
  },

  /** Scoped to one team. */
  TEAM_MANAGER: {
    ...PUBLIC_READ,
    team: READ_UPDATE,
    person: CREATE_READ_UPDATE,
    registration: ALL,
    result: CREATE_READ,
  },

  COACH: {
    ...PUBLIC_READ,
    person: READ,
    registration: READ,
  },

  REFEREE: {
    ...PUBLIC_READ,
  },

  PLAYER: {
    ...PUBLIC_READ,
  },
};

/** Does this role grant `action` on `resource`, ignoring scope? */
export function grants(role: Role, action: Action, resource: Resource): boolean {
  return ROLE_GRANTS[role][resource]?.includes(action) ?? false;
}
