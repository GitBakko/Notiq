
import { PrismaClient } from '@prisma/client';
import * as authService from './src/services/auth.service';
import * as notebookService from './src/services/notebook.service';
import * as noteService from './src/services/note.service';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Creating user...');
    const email = `repro-${uuidv4()}@example.com`;
    const password = 'password123';

    const user = await prisma.user.create({
      data: {
        email,
        password: 'hash', // dummy
        name: 'Repro User'
      }
    });
    console.log('User created:', user.id);

    console.log('Creating notebook...');
    const notebook = await notebookService.createNotebook(user.id, 'Default Notebook');
    console.log('Notebook created:', notebook.id);

    console.log('Creating note with encrypted block...');
    const content = '<encrypted-block ciphertext=""></encrypted-block><p></p>';
    const noteId = uuidv4();

    const note = await noteService.createNote(user.id, notebook.id, 'Secret Note', content, noteId);
    console.log('Note created successfully:', note.id);

  } catch (error) {
    console.error('Error reproducing 500:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
