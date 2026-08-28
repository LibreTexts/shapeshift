import 'dotenv/config';
import { confirm } from '@inquirer/prompts';
import { DataTypes } from 'sequelize';
import { Environment } from '../lib/environment';
import { Job, sequelize } from '../model';
import { exit } from 'process';

const MIGRATION_NAME = '003-add-progress-columns';

/**
 * Rows per backfill statement. The `jobs` history is unbounded, and a single unqualified UPDATE
 * across it holds row locks for the length of the scan and hands the read replicas one large
 * transaction to replay. Batching keeps both bounded.
 */
const BACKFILL_BATCH_SIZE = 1000;

/** Breather between batches so replicas can keep up. */
const BACKFILL_PAUSE_MS = 100;

/**
 * Neither column specifies `after`. Positional ADD COLUMN is INSTANT only on MySQL 8.0.29+; below
 * that it forces a full table rebuild under an exclusive metadata lock. Appending to the end of the
 * row is INSTANT from 8.0.12, and column order in the physical table buys nothing here.
 */
async function run() {
  Environment.load();
  const env = Environment.getSystemEnvironment();

  const [versionRows] = await sequelize.query('SELECT VERSION() AS version');
  const serverVersion = (versionRows as { version?: string }[])[0]?.version ?? 'unknown';
  console.log(`Server version: ${serverVersion}`);

  const confirmation = await confirm({
    message: `Run migration "${MIGRATION_NAME}" in the "${env}" environment?`,
  });
  if (!confirmation) {
    console.log('Migration canceled.');
    return;
  }

  const qi = sequelize.getQueryInterface();
  const columns = await qi.describeTable('jobs');

  if ('progress' in columns) {
    console.log('Column "progress" already exists — skipping.');
  } else {
    await qi.addColumn('jobs', 'progress', {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    console.log('Added "progress" column.');
  }

  if ('stage' in columns) {
    console.log('Column "stage" already exists — skipping.');
  } else {
    await qi.addColumn('jobs', 'stage', { type: DataTypes.STRING(64), allowNull: true });
    console.log('Added "stage" column.');
  }

  // Jobs that finished before this migration ran have no recorded progress. Backfilling the
  // terminal ones keeps the job endpoints from reporting 0% for work that is long done.
  //
  // `silent` so the write does not touch `updatedAt`: that column is the staleness signal
  // (see JobService.getStaleAfterMinutes) and rewriting it across the whole history would be a lie
  // about when this work happened. `stage` is left null — the read path already labels a finished
  // job "Complete" regardless of what the column holds, so writing it would be pure churn.
  //
  // The predicate excludes rows it has already updated, so the loop is safe to re-run and safe to
  // interrupt partway through.
  let backfilled = 0;
  for (;;) {
    const [affected] = await Job.update(
      { progress: 100 },
      { where: { status: 'finished', progress: 0 }, limit: BACKFILL_BATCH_SIZE, silent: true },
    );
    backfilled += affected;
    if (affected < BACKFILL_BATCH_SIZE) break;
    console.log(`Backfilled ${backfilled} row(s) so far...`);
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_PAUSE_MS));
  }
  console.log(`Backfilled progress = 100 on ${backfilled} already-finished job(s).`);
}

run()
  .then(() => exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    exit(1);
  });
