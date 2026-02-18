
import prisma from '../plugins/prisma';

export const getSetting = async (key: string, defaultValue: string = 'true'): Promise<string> => {
  const setting = await prisma.systemSetting.findUnique({
    where: { key },
  });
  return setting?.value ?? defaultValue;
};

export const setSetting = async (key: string, value: string, description?: string) => {
  // Log change could go here if we have request context, typically AuditLog is better in Controller
  return prisma.systemSetting.upsert({
    where: { key },
    update: { value, description },
    create: { key, value, description },
  });
};

export const getBooleanSetting = async (key: string, defaultValue: boolean = true): Promise<boolean> => {
  const val = await getSetting(key, defaultValue ? 'true' : 'false');
  return val === 'true';
};
