import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Workspace-level defaults for per-agent settings, set from Account Preferences.
 *
 * Both columns are nullable and mean "no workspace choice — fall through to the
 * layer below", mirroring how `agents.autofix_enabled` already expresses "no
 * agent choice". Resolution runs newest-choice-wins:
 *
 *   agent flag ?? tenant default ?? (env / deployment default)
 *
 * `agents.record_messages` loses its NOT NULL + DEFAULT so it can carry the same
 * "no explicit choice" state that `autofix_enabled` already does. Existing rows
 * are deliberately left alone: unlike the pre-feature Auto-fix `false` (which
 * predated any toggle and was never a user choice), recording has been
 * user-toggleable for many releases, so a stored `false` may well be deliberate.
 * Collapsing it to NULL could silently switch recording back on. Every agent
 * that exists today therefore keeps an explicit value and ignores the workspace
 * default; only agents created from here on inherit it.
 */
export class AddWorkspaceAgentDefaults1801800000000 implements MigrationInterface {
  name = 'AddWorkspaceAgentDefaults1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Every statement here is catalog-only, but each still takes ACCESS
    // EXCLUSIVE — bound the wait so a deploy queues behind a long read instead
    // of blocking the table indefinitely.
    await queryRunner.query(`SET lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "autofix_default_enabled" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "recording_default_enabled" boolean`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "record_messages" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "record_messages" DROP NOT NULL`);
    await queryRunner.query(`RESET lock_timeout`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    // NULL meant "inherit the workspace default"; the pre-migration column had
    // no NULLs, so collapse them to the old column default before restoring the
    // constraint. `true` is the default this migration replaced (set by
    // EnableRecordingForNewAgents1801500000000).
    await queryRunner.query(
      `UPDATE "agents" SET "record_messages" = true WHERE "record_messages" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "record_messages" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "record_messages" SET DEFAULT true`);
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN IF EXISTS "recording_default_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN IF EXISTS "autofix_default_enabled"`,
    );
    await queryRunner.query(`RESET lock_timeout`);
  }
}
