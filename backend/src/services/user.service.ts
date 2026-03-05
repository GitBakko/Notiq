import prisma from '../plugins/prisma';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MultipartFile } from '@fastify/multipart';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { logEvent } from './audit.service';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads/avatars');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export const updateUser = async (userId: string, data: {
  name?: string;
  surname?: string;
  gender?: string;
  dateOfBirth?: string; // ISO string
  placeOfBirth?: string;
  mobile?: string;
  avatarUrl?: string;
  emailNotificationsEnabled?: boolean;
  locale?: string;
}) => {
  let dob: Date | undefined | null = undefined;
  if (data.dateOfBirth) {
    const parsed = new Date(data.dateOfBirth);
    if (!isNaN(parsed.getTime())) {
      dob = parsed;
    }
  } else if (data.dateOfBirth === '') {
    dob = null; // Clear date if empty string provided
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      name: data.name,
      surname: data.surname,
      gender: data.gender,
      dateOfBirth: dob,
      placeOfBirth: data.placeOfBirth,
      mobile: data.mobile,
      avatarUrl: data.avatarUrl,
      ...(data.emailNotificationsEnabled !== undefined && { emailNotificationsEnabled: data.emailNotificationsEnabled }),
      ...(data.locale && { locale: data.locale }),
    },
  });
};

const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export const uploadAvatar = async (userId: string, file: MultipartFile) => {
  if (!AVATAR_MIME_TYPES.has(file.mimetype)) throw new BadRequestError('errors.user.onlyImagesForAvatar');

  const filename = `${userId}-${Date.now()}${path.extname(file.filename)}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  await pipeline(file.file, fs.createWriteStream(filepath));

  const avatarUrl = `/uploads/avatars/${filename}`;

  return prisma.user.update({
    where: { id: userId },
    data: { avatarUrl },
  });
};

export const getUser = async (userId: string) => {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      surname: true,
      gender: true,
      dateOfBirth: true,
      placeOfBirth: true,
      mobile: true,
      avatarUrl: true,
      color: true,
      emailNotificationsEnabled: true,
      createdAt: true,
    },
  });
};

export const changePassword = async (userId: string, oldPassword: string, newPassword: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('errors.user.notFound');

  const valid = await bcrypt.compare(oldPassword, user.password);
  if (!valid) throw new BadRequestError('errors.user.invalidOldPassword');

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  const result = await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword, tokenVersion: { increment: 1 } },
    select: { id: true, email: true, name: true },
  });

  logEvent(userId, 'PASSWORD_CHANGED');

  return result;
};
