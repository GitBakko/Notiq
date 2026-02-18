import prisma from '../plugins/prisma';
import logger from '../utils/logger';

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
    logger.error(error, 'Failed to create audit log');
    // Don't throw, audit logging failure shouldn't block main flow
  }
};
