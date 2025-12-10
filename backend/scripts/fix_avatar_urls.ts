
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Checking for users with hardcoded localhost avatar URLs...');

  const users = await prisma.user.findMany({
    where: {
      avatarUrl: {
        startsWith: 'http://localhost:3001'
      }
    }
  });

  console.log(`Found ${users.length} users to update.`);

  for (const user of users) {
    if (user.avatarUrl) {
      const newUrl = user.avatarUrl.replace('http://localhost:3001', '');
      console.log(`Updating user ${user.email}: ${user.avatarUrl} -> ${newUrl}`);

      await prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: newUrl }
      });
    }
  }

  console.log('Done!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
