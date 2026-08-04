import { AddWorkspaceAgentDefaults1801800000000 } from './1801800000000-AddWorkspaceAgentDefaults';

describe('AddWorkspaceAgentDefaults1801800000000', () => {
  const migration = new AddWorkspaceAgentDefaults1801800000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('adds both nullable workspace defaults under a bounded lock wait', async () => {
    await migration.up(queryRunner);

    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET lock_timeout = '5s'");
    expect(statements.at(-1)).toContain('RESET lock_timeout');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "autofix_default_enabled" boolean');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "recording_default_enabled" boolean');
    // Nullable by omission: a NOT NULL here would force a value on every
    // existing tenant and destroy the "no workspace choice" state.
    expect(sql).not.toContain('NOT NULL DEFAULT');
  });

  it('lets record_messages carry the "no explicit choice" state', async () => {
    await migration.up(queryRunner);

    const sql = query.mock.calls.map(([s]) => s).join(' ');
    expect(sql).toContain('ALTER COLUMN "record_messages" DROP DEFAULT');
    expect(sql).toContain('ALTER COLUMN "record_messages" DROP NOT NULL');
  });

  it('never rewrites existing recording choices', async () => {
    await migration.up(queryRunner);

    // Unlike the Auto-fix nullable migration, a stored `false` here may be a
    // deliberate user choice — collapsing it to NULL would silently switch
    // recording back on for anyone who turned it off.
    const sql = query.mock.calls.map(([s]) => s).join(' ');
    expect(sql).not.toContain('UPDATE "agents"');
  });

  it('collapses NULLs back before restoring NOT NULL on rollback', async () => {
    await migration.down(queryRunner);

    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    const backfillAt = statements.findIndex((s: string) => s.includes('UPDATE "agents"'));
    const notNullAt = statements.findIndex((s: string) => s.includes('SET NOT NULL'));

    expect(backfillAt).toBeGreaterThanOrEqual(0);
    // Order matters: SET NOT NULL fails outright if any NULL survives.
    expect(backfillAt).toBeLessThan(notNullAt);
    expect(sql).toContain('SET "record_messages" = true WHERE "record_messages" IS NULL');
    expect(sql).toContain('ALTER COLUMN "record_messages" SET DEFAULT true');
  });

  it('drops both workspace columns on rollback', async () => {
    await migration.down(queryRunner);

    const sql = query.mock.calls.map(([s]) => s).join(' ');
    expect(sql).toContain('DROP COLUMN IF EXISTS "autofix_default_enabled"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "recording_default_enabled"');
  });
});
