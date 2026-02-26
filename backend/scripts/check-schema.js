/**
 * Schema diagnostic script — run on production server to compare
 * actual DB columns with what Prisma schema expects.
 *
 * Usage: cd backend && node scripts/check-schema.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Expected columns per table (from schema.prisma)
const expected = {
  KanbanBoard: [
    'id', 'title', 'description', 'coverImage', 'avatarUrl',
    'noteId', 'noteLinkedById', 'ownerId', 'createdAt', 'updatedAt',
  ],
  KanbanColumn: ['id', 'title', 'position', 'boardId', 'createdAt', 'updatedAt'],
  KanbanCard: [
    'id', 'title', 'description', 'position', 'columnId',
    'assigneeId', 'dueDate', 'noteId', 'noteLinkedById', 'createdAt', 'updatedAt',
  ],
  KanbanComment: ['id', 'content', 'cardId', 'authorId', 'createdAt', 'updatedAt'],
  KanbanCardActivity: [
    'id', 'cardId', 'userId', 'action', 'fromColumnTitle',
    'toColumnTitle', 'metadata', 'createdAt',
  ],
  KanbanBoardChat: ['id', 'boardId', 'authorId', 'content', 'createdAt'],
  KanbanReminder: [
    'id', 'cardId', 'userId', 'boardId', 'dueDate', 'isDone', 'createdAt', 'updatedAt',
  ],
  SharedKanbanBoard: [
    'id', 'boardId', 'userId', 'permission', 'status', 'createdAt', 'updatedAt',
  ],
  // Non-kanban tables that had recent changes
  GroupMember: ['groupId', 'userId', 'joinedAt'],
  PendingGroupInvite: ['id', 'groupId', 'email', 'invitedBy', 'createdAt'],
};

async function main() {
  const client = await pool.connect();
  try {
    // Get all tables
    const tablesRes = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    const existingTables = new Set(tablesRes.rows.map(r => r.table_name));

    // Get all columns
    const colsRes = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
    );
    const actualCols = {};
    for (const row of colsRes.rows) {
      if (!actualCols[row.table_name]) actualCols[row.table_name] = [];
      actualCols[row.table_name].push(row.column_name);
    }

    // Get applied migrations
    const migrationsRes = await client.query(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`
    );

    console.log('\n=== APPLIED MIGRATIONS ===');
    for (const m of migrationsRes.rows) {
      const status = m.finished_at ? 'OK' : 'FAILED';
      console.log(`  [${status}] ${m.migration_name}`);
    }

    console.log('\n=== SCHEMA COMPARISON ===');
    let issues = 0;

    for (const [table, cols] of Object.entries(expected)) {
      if (!existingTables.has(table)) {
        console.log(`\n  MISSING TABLE: ${table}`);
        issues++;
        continue;
      }

      const actual = actualCols[table] || [];
      const missing = cols.filter(c => !actual.includes(c));
      const extra = actual.filter(c => !cols.includes(c));

      if (missing.length > 0) {
        console.log(`\n  ${table}: MISSING COLUMNS: ${missing.join(', ')}`);
        issues++;
      }
      if (extra.length > 0) {
        console.log(`  ${table}: EXTRA COLUMNS (not in expected list): ${extra.join(', ')}`);
      }
      if (missing.length === 0 && extra.length === 0) {
        console.log(`  ${table}: OK`);
      } else if (missing.length === 0) {
        console.log(`  ${table}: OK (has extra columns, that's fine)`);
      }
    }

    if (issues === 0) {
      console.log('\n  ALL TABLES AND COLUMNS MATCH! If P2022 persists, run: npx prisma generate && pm2 restart notiq-backend');
    } else {
      console.log(`\n  FOUND ${issues} ISSUE(S). Fix with the SQL below, then run: npx prisma generate && pm2 restart notiq-backend`);
    }

    console.log('\n=== ALL EXISTING TABLES ===');
    console.log('  ' + [...existingTables].sort().join(', '));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
