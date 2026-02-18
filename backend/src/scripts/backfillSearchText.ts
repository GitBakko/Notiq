/**
 * Backfill searchText for all existing notes.
 * Run: cd backend && npx tsx src/scripts/backfillSearchText.ts
 *
 * This script:
 * 1. Reads all non-encrypted notes
 * 2. Extracts plain text from TipTap JSON content
 * 3. Updates searchText field (the DB trigger auto-updates searchVector)
 */
import prisma from '../plugins/prisma';
import { extractTextFromTipTapJson } from '../utils/extractText';

async function main() {
  console.log('Starting searchText backfill...');

  const notes = await prisma.note.findMany({
    where: { isEncrypted: false },
    select: { id: true, content: true, searchText: true },
  });

  console.log(`Found ${notes.length} non-encrypted notes to process.`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const note of notes) {
    try {
      const newSearchText = extractTextFromTipTapJson(note.content);

      // Skip if searchText is already populated and identical
      if (note.searchText === newSearchText) {
        skipped++;
        continue;
      }

      await prisma.note.update({
        where: { id: note.id },
        data: { searchText: newSearchText },
      });

      updated++;
    } catch (e) {
      console.error(`Failed to update note ${note.id}:`, e);
      errors++;
    }
  }

  console.log(`Done. Updated: ${updated}, Skipped (already current): ${skipped}, Errors: ${errors}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
