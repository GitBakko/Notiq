import prisma from '../plugins/prisma';

export interface SearchResult {
  id: string;
  title: string;
  notebookId: string;
  notebookName: string;
  updatedAt: Date;
  isPinned: boolean;
  titleHighlight: string;
  contentHighlight: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  limit: number;
}

export const searchNotes = async (
  userId: string,
  query: string,
  page: number = 1,
  limit: number = 20,
  notebookId?: string
): Promise<SearchResponse> => {
  const offset = (page - 1) * limit;

  const countNotebookCond = notebookId ? `AND n."notebookId" = $3` : '';
  const countParams = notebookId ? [userId, query, notebookId] : [userId, query];

  const countRows: any[] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int as total
    FROM "Note" n
    WHERE n."userId" = $1
      AND n."isTrashed" = false
      AND n."isEncrypted" = false
      AND n."searchVector" @@ plainto_tsquery('simple', $2)
      ${countNotebookCond}
  `, ...countParams);

  const total = countRows[0]?.total ?? 0;

  const searchNotebookCond = notebookId ? `AND n."notebookId" = $5` : '';
  const searchParams = notebookId
    ? [userId, query, limit, offset, notebookId]
    : [userId, query, limit, offset];

  const results: SearchResult[] = await prisma.$queryRawUnsafe(`
    SELECT
      n."id",
      n."title",
      n."notebookId",
      nb."name" as "notebookName",
      n."updatedAt",
      n."isPinned",
      ts_headline('simple', coalesce(n."title", ''), plainto_tsquery('simple', $2),
        'StartSel=[[HL]], StopSel=[[/HL]], MaxWords=50, MinWords=10') as "titleHighlight",
      ts_headline('simple', coalesce(n."searchText", ''), plainto_tsquery('simple', $2),
        'StartSel=[[HL]], StopSel=[[/HL]], MaxWords=50, MinWords=10') as "contentHighlight",
      ts_rank(n."searchVector", plainto_tsquery('simple', $2)) as "rank"
    FROM "Note" n
    LEFT JOIN "Notebook" nb ON nb."id" = n."notebookId"
    WHERE n."userId" = $1
      AND n."isTrashed" = false
      AND n."isEncrypted" = false
      AND n."searchVector" @@ plainto_tsquery('simple', $2)
      ${searchNotebookCond}
    ORDER BY n."isPinned" DESC, "rank" DESC, n."updatedAt" DESC
    LIMIT $3 OFFSET $4
  `, ...searchParams);

  return { results, total, page, limit };
};
