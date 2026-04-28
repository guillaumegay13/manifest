import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the parallel `(override_model, override_provider, override_auth_type,
 * auto_assigned_model, fallback_models)` columns on tier_assignments,
 * header_tiers, and specificity_assignments with structured `ModelRoute` jsonb
 * columns: `override_route`, `auto_assigned_route` (where applicable), and
 * `fallback_routes`.
 *
 * Backfill strategy:
 *  - `override_route`: lossless build from the three legacy columns.
 *  - `auto_assigned_route`: best-effort lookup against the user's connected
 *    providers (resolved by model name → provider+authType). Ambiguous or
 *    absent matches stay null; the auto-assign service repopulates on the next
 *    provider mutation.
 *  - `fallback_routes`: same best-effort join, ordered to preserve sequence.
 */
export class IntroduceModelRoutes1782000000000 implements MigrationInterface {
  name = 'IntroduceModelRoutes1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the new columns nullable so the backfill can populate in place.
    await queryRunner.query(`
      ALTER TABLE tier_assignments
        ADD COLUMN override_route jsonb,
        ADD COLUMN auto_assigned_route jsonb,
        ADD COLUMN fallback_routes jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE specificity_assignments
        ADD COLUMN override_route jsonb,
        ADD COLUMN auto_assigned_route jsonb,
        ADD COLUMN fallback_routes jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE header_tiers
        ADD COLUMN override_route jsonb,
        ADD COLUMN fallback_routes jsonb
    `);

    // 2. Lossless override_route backfill: every legacy override row carries
    //    model + provider + auth_type, so the route is fully determined.
    for (const table of ['tier_assignments', 'specificity_assignments', 'header_tiers']) {
      await queryRunner.query(`
        UPDATE ${table}
        SET override_route = jsonb_build_object(
          'provider', override_provider,
          'authType', override_auth_type,
          'model', override_model
        )
        WHERE override_model IS NOT NULL
          AND override_provider IS NOT NULL
          AND override_auth_type IS NOT NULL
      `);
    }

    // 3. Best-effort auto_assigned_route backfill via the user's connected
    //    providers. Picks a unique (provider, auth_type) match for the model;
    //    rows with zero or multiple matches stay null and get repopulated by
    //    TierAutoAssignService on the next provider change.
    for (const table of ['tier_assignments', 'specificity_assignments']) {
      await queryRunner.query(`
        UPDATE ${table} t
        SET auto_assigned_route = jsonb_build_object(
          'provider', m.provider,
          'authType', m.auth_type,
          'model', t.auto_assigned_model
        )
        FROM (
          SELECT up.agent_id, m.model_name, up.provider, up.auth_type,
                 COUNT(*) OVER (PARTITION BY up.agent_id, m.model_name) AS match_count
          FROM user_providers up,
               jsonb_array_elements(up.cached_models::jsonb) AS m_elem(model),
               LATERAL (SELECT m_elem.model->>'model_name' AS model_name) m
          WHERE up.is_active
        ) m
        WHERE t.agent_id = m.agent_id
          AND t.auto_assigned_model = m.model_name
          AND m.match_count = 1
          AND t.auto_assigned_model IS NOT NULL
      `);
    }

    // 4. Best-effort fallback_routes backfill: walk each fallback name in
    //    order, looking up a unique provider+auth match per agent. Names
    //    without a unique match are dropped (the user re-saves to recover).
    for (const table of ['tier_assignments', 'specificity_assignments', 'header_tiers']) {
      await queryRunner.query(`
        UPDATE ${table} t
        SET fallback_routes = sub.routes
        FROM (
          SELECT t2.id,
                 jsonb_agg(
                   jsonb_build_object(
                     'provider', m.provider,
                     'authType', m.auth_type,
                     'model', m.model_name
                   )
                   ORDER BY ord.idx
                 ) FILTER (WHERE m.provider IS NOT NULL) AS routes
          FROM ${table} t2,
               jsonb_array_elements_text(t2.fallback_models::jsonb)
                 WITH ORDINALITY AS ord(model_name, idx)
          LEFT JOIN LATERAL (
            SELECT up.provider, up.auth_type, m_elem.model->>'model_name' AS model_name,
                   COUNT(*) OVER (PARTITION BY up.agent_id, m_elem.model->>'model_name') AS match_count
            FROM user_providers up,
                 jsonb_array_elements(up.cached_models::jsonb) AS m_elem(model)
            WHERE up.agent_id = t2.agent_id
              AND up.is_active
              AND m_elem.model->>'model_name' = ord.model_name
          ) m ON m.match_count = 1
          WHERE t2.fallback_models IS NOT NULL
          GROUP BY t2.id
        ) sub
        WHERE t.id = sub.id
      `);
    }

    // 5. Drop legacy columns now that the new shape carries their semantics.
    await queryRunner.query(`
      ALTER TABLE tier_assignments
        DROP COLUMN override_model,
        DROP COLUMN override_provider,
        DROP COLUMN override_auth_type,
        DROP COLUMN auto_assigned_model,
        DROP COLUMN fallback_models
    `);
    await queryRunner.query(`
      ALTER TABLE specificity_assignments
        DROP COLUMN override_model,
        DROP COLUMN override_provider,
        DROP COLUMN override_auth_type,
        DROP COLUMN auto_assigned_model,
        DROP COLUMN fallback_models
    `);
    await queryRunner.query(`
      ALTER TABLE header_tiers
        DROP COLUMN override_model,
        DROP COLUMN override_provider,
        DROP COLUMN override_auth_type,
        DROP COLUMN fallback_models
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore legacy columns and project route fields back into them. Rows
    // whose routes were null (because the up() backfill couldn't resolve a
    // unique match) come back with null legacy values — same pre-up state.
    await queryRunner.query(`
      ALTER TABLE tier_assignments
        ADD COLUMN override_model varchar,
        ADD COLUMN override_provider varchar,
        ADD COLUMN override_auth_type varchar,
        ADD COLUMN auto_assigned_model varchar,
        ADD COLUMN fallback_models text
    `);
    await queryRunner.query(`
      ALTER TABLE specificity_assignments
        ADD COLUMN override_model varchar,
        ADD COLUMN override_provider varchar,
        ADD COLUMN override_auth_type varchar,
        ADD COLUMN auto_assigned_model varchar,
        ADD COLUMN fallback_models text
    `);
    await queryRunner.query(`
      ALTER TABLE header_tiers
        ADD COLUMN override_model varchar,
        ADD COLUMN override_provider varchar,
        ADD COLUMN override_auth_type varchar,
        ADD COLUMN fallback_models text
    `);

    for (const table of ['tier_assignments', 'specificity_assignments', 'header_tiers']) {
      await queryRunner.query(`
        UPDATE ${table}
        SET override_model = override_route->>'model',
            override_provider = override_route->>'provider',
            override_auth_type = override_route->>'authType'
        WHERE override_route IS NOT NULL
      `);
      await queryRunner.query(`
        UPDATE ${table}
        SET fallback_models = (
          SELECT jsonb_agg(elem->>'model')::text
          FROM jsonb_array_elements(fallback_routes) elem
        )
        WHERE fallback_routes IS NOT NULL
      `);
    }
    for (const table of ['tier_assignments', 'specificity_assignments']) {
      await queryRunner.query(`
        UPDATE ${table}
        SET auto_assigned_model = auto_assigned_route->>'model'
        WHERE auto_assigned_route IS NOT NULL
      `);
    }

    await queryRunner.query(`
      ALTER TABLE tier_assignments
        DROP COLUMN override_route,
        DROP COLUMN auto_assigned_route,
        DROP COLUMN fallback_routes
    `);
    await queryRunner.query(`
      ALTER TABLE specificity_assignments
        DROP COLUMN override_route,
        DROP COLUMN auto_assigned_route,
        DROP COLUMN fallback_routes
    `);
    await queryRunner.query(`
      ALTER TABLE header_tiers
        DROP COLUMN override_route,
        DROP COLUMN fallback_routes
    `);
  }
}
