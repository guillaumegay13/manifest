import { QueryRunner } from 'typeorm';
import { IntroduceModelRoutes1782000000000 } from './1782000000000-IntroduceModelRoutes';

describe('IntroduceModelRoutes1782000000000', () => {
  let migration: IntroduceModelRoutes1782000000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new IntroduceModelRoutes1782000000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('IntroduceModelRoutes1782000000000');
  });

  it('reads cached models by id with legacy model_name compatibility', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);

    const upSql = queryRunner.query.mock.calls.map((call) => call[0] as string).join('\n');
    expect(upSql).toContain("COALESCE(m_elem.model->>'id', m_elem.model->>'model_name')");
    expect(upSql).not.toContain("SELECT m_elem.model->>'model_name' AS model_name");
  });

  it('infers older model-only overrides before dropping legacy columns', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);

    const upSql = queryRunner.query.mock.calls.map((call) => call[0] as string).join('\n');
    expect(upSql).toContain('AND t.override_route IS NULL');
    expect(upSql).toContain('AND m.model_name = t.override_model');
    expect(upSql).toContain(
      'AND (t.override_provider IS NULL OR lower(up.provider) = lower(t.override_provider))',
    );
    expect(upSql).toContain(
      'AND (t.override_auth_type IS NULL OR up.auth_type = t.override_auth_type)',
    );
  });
});
