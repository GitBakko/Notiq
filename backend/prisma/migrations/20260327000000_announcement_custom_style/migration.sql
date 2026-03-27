-- Add optional custom color and icon to announcements
ALTER TABLE "Announcement" ADD COLUMN IF NOT EXISTS "customColor" TEXT;
ALTER TABLE "Announcement" ADD COLUMN IF NOT EXISTS "customIcon" TEXT;
