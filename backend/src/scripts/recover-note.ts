/**
 * recover-note.ts — Diagnose & recover a note that opens blank in the editor.
 *
 * Root cause this addresses: Hocuspocus prefers `ydocState` over `content` on load
 * (see backend/src/hocuspocus.ts fetch()). If `ydocState` is corrupt/empty but
 * `content` is still intact, the editor shows a blank page. Nulling `ydocState`
 * forces the fallback that rebuilds the Yjs doc from the good `content`.
 *
 * SAFE BY DEFAULT: diagnosis is read-only. The fix only runs with --clear-ydoc
 * AND --id=<noteId>, and REFUSES to run if `content` is empty/too short
 * (in that case the content is truly gone — restore from a DB backup instead).
 *
 * Usage (run on the production server, in backend/):
 *   npx tsx src/scripts/recover-note.ts "Informazioni di connessione"   # diagnose
 *   npx tsx src/scripts/recover-note.ts --clear-ydoc --id=<noteId>      # recover
 *
 * After --clear-ydoc: disconnect all clients from the note, then
 *   pm2 restart notiq-backend   (flushes in-memory Hocuspocus docs)
 * and reopen the note.
 */
import prisma from '../plugins/prisma';

async function main() {
  const args = process.argv.slice(2);
  const doClear = args.includes('--clear-ydoc');
  const idArg = args.find((a) => a.startsWith('--id='))?.split('=')[1];
  const search = args.find((a) => !a.startsWith('--')) ?? 'Informazioni di connessione';

  if (doClear) {
    if (!idArg) {
      console.error('ERROR: --clear-ydoc requires --id=<noteId>');
      process.exit(1);
    }
    const note = await prisma.note.findUnique({
      where: { id: idArg },
      select: { id: true, title: true, content: true, ydocState: true, isEncrypted: true, noteType: true },
    });
    if (!note) {
      console.error(`ERROR: note ${idArg} not found`);
      process.exit(1);
    }
    const contentLen = note.content?.length ?? 0;
    const ydocLen = note.ydocState?.length ?? 0;
    console.log(`Note     : ${note.title}`);
    console.log(`content  : ${contentLen} chars`);
    console.log(`ydocState: ${ydocLen} bytes`);
    console.log(`type     : ${note.noteType} | isEncrypted: ${note.isEncrypted}`);

    // Refuse if content can't actually recover the note.
    if (contentLen < 50) {
      console.error('\nREFUSING: `content` is empty/too short. Nulling ydocState would NOT');
      console.error('recover this note. Restore the note from a DB backup instead.');
      process.exit(1);
    }
    if (note.isEncrypted) {
      console.warn('\nWARNING: this is an ENCRYPTED note. The blank page may be a vault');
      console.warn('decryption issue, not data loss. Verify the vault PIN flow before clearing.');
    }

    await prisma.note.update({ where: { id: idArg }, data: { ydocState: null } });
    console.log('\nOK: ydocState cleared. Now:');
    console.log('  1. Close every open tab of this note (all devices).');
    console.log('  2. pm2 restart notiq-backend   (flush in-memory Hocuspocus docs)');
    console.log('  3. Reopen the note — fetch() rebuilds Yjs from `content`.');
    return;
  }

  // ---- Diagnose mode (read-only) ----
  const notes = await prisma.note.findMany({
    where: { title: { contains: search, mode: 'insensitive' } },
    select: {
      id: true, title: true, noteType: true, isVault: true, isEncrypted: true,
      isTrashed: true, content: true, ydocState: true, updatedAt: true, userId: true,
    },
  });

  if (notes.length === 0) {
    console.log(`No notes matching "${search}".`);
    return;
  }

  for (const n of notes) {
    console.log('────────────────────────────────────────');
    console.log('id        :', n.id);
    console.log('title     :', n.title);
    console.log('owner     :', n.userId);
    console.log('type      :', n.noteType, '| isVault:', n.isVault, '| isEncrypted:', n.isEncrypted, '| trashed:', n.isTrashed);
    console.log('content   :', (n.content?.length ?? 0), 'chars');
    console.log('ydocState :', (n.ydocState?.length ?? 0), 'bytes');
    console.log('updatedAt :', n.updatedAt.toISOString());
    console.log('preview   :', (n.content ?? '').slice(0, 400));
  }
  console.log('────────────────────────────────────────');
  console.log('\nRead: content >> ydocState  → recoverable, run with --clear-ydoc --id=<id>');
  console.log('Read: content ~0            → content lost, restore from backup');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
