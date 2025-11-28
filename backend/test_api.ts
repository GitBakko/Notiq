
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const API_URL = 'http://localhost:3001/api';

async function main() {
  try {
    // 1. Generate Token
    // We need a valid user ID. I'll use a random one, assuming the backend doesn't check user existence for every request (it usually just verifies signature).
    // But createNote uses request.user.id to create the note. If user doesn't exist in DB, it might fail with FK error?
    // Yes, Note -> User relation.
    // So I need a valid user ID.
    // I'll use the one from repro_500.ts output if I can, or create a new one via Prisma in this script.
    // But I can't easily mix Prisma and API call in one script if I want to keep it simple.
    // I'll assume the user created in repro_500.ts exists.
    // User ID: d59c4a1c-517f-491f-814a-45132db6d0d1 (from previous step output)
    const userId = 'd59c4a1c-517f-491f-814a-45132db6d0d1';

    // Also need a valid notebook ID.
    // Notebook ID: 33dcc27d-8f74-4642-9a12-5e7d4b808d91
    const notebookId = '33dcc27d-8f74-4642-9a12-5e7d4b808d91';

    const token = jwt.sign({ id: userId, name: 'Repro User', email: 'repro@example.com' }, JWT_SECRET);
    console.log('Token generated');

    // 2. Send POST request
    const noteId = uuidv4();
    const payload = {
      id: noteId,
      title: 'API Test Note',
      notebookId: notebookId,
      content: '<encrypted-block ciphertext=""></encrypted-block><p></p>'
    };

    console.log('Sending POST /notes...');
    const response = await fetch(`${API_URL}/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    console.log('Response status:', response.status);
    const data = await response.json();
    console.log('Response data:', data);

  } catch (error: any) {
    console.error('API Request Failed:', error);
  }
}

main();
