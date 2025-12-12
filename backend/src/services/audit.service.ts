import prisma from '../plugins/prisma';

export const logEvent = async (userId: string, event: string, details?: any) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        event,
        details,
      },
    });
  } catch (error) {
    console.error('Failed to create audit log', error);
    // Don't throw, audit logging failure shouldn't block main flow
  }
};
