-- Add tsvector column for full-text search
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "searchVector" TSVECTOR;

-- Function to auto-update searchVector from title + searchText
CREATE OR REPLACE FUNCTION note_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."searchText", '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: fires on INSERT or UPDATE of title/searchText
CREATE TRIGGER note_search_vector_trigger
  BEFORE INSERT OR UPDATE OF "title", "searchText"
  ON "Note" FOR EACH ROW
  EXECUTE FUNCTION note_search_vector_update();

-- GIN index for fast full-text queries
CREATE INDEX IF NOT EXISTS "Note_searchVector_idx" ON "Note" USING GIN ("searchVector");

-- Backfill existing rows
UPDATE "Note" SET "searchVector" =
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("searchText", '')), 'B');
