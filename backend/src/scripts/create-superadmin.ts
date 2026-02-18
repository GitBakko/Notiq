
import 'dotenv/config';
import prisma from '../plugins/prisma';
import bcrypt from 'bcrypt';

const createSuperAdmin = async () => {
  const email = 'superadmin@notiq.ai';
  const password = 'superadmin';
  const name = 'Super Admin';

  try {
    let user;
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      console.log('Super Admin already exists. Checking for invitations...');
      user = existing;
    } else {
      const hashedPassword = await bcrypt.hash(password, 10);
      user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role: 'SUPERADMIN',
          isVerified: true,
          invitesAvailable: 100,
        },
      });
      console.log(`Super Admin created successfully: ${user.email}`);
    }

    // Check existing invites
    const existingInvitesCount = await prisma.invitation.count({
      where: { creatorId: user.id },
    });

    if (existingInvitesCount < 5) {
      console.log(`Super Admin has ${existingInvitesCount} invites. Generating more to reach 5...`);
      const needed = 5 - existingInvitesCount;

      const codes = Array.from({ length: needed }).map(() => ({
        code: `INV-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        creatorId: user.id,
        status: 'PENDING' as const,
      }));

      for (const data of codes) {
        await prisma.invitation.create({ data });
        console.log(`  - Created code: ${data.code}`);
      }
      console.log(`Added ${needed} new invitation codes.`);
    } else {
      console.log(`Super Admin already has ${existingInvitesCount} invitation codes.`);
    }
  } catch (error) {
    console.error('Error in Super Admin setup:', error);
  } finally {
    await prisma.$disconnect();
  }
};

createSuperAdmin();
