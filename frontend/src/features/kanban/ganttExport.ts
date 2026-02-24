import ExcelJS from 'exceljs';
import {
  differenceInDays,
  eachDayOfInterval,
  format,
  isToday as isDateToday,
  isPast as isDatePast,
  startOfDay,
  isSameDay,
  isWithinInterval,
} from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import type { KanbanBoard } from './types';

// ── Colors (ARGB without #) ────────────────────────────────────────────

const COLORS = {
  emerald600: 'FF059669',
  emerald50: 'FFECFDF5',
  white: 'FFFFFFFF',
  gray50: 'FFF9FAFB',
  gray100: 'FFF3F4F6',
  gray200: 'FFE5E7EB',
  gray400: 'FF9CA3AF',
  gray600: 'FF4B5563',
  gray800: 'FF1F2937',
  red100: 'FFFEE2E2',
  red400: 'FFFCA5A5',
  red600: 'FFDC2626',
  amber100: 'FFFEF3C7',
  amber400: 'FFFBBF24',
  amber600: 'FFD97706',
  green100: 'FFD1FAE5',
  green400: 'FF4ADE80',
  blue100: 'FFDBEAFE',
  blue600: 'FF2563EB',
  todayMarker: 'FF065F46',
};

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: COLORS.gray200 } },
  bottom: { style: 'thin', color: { argb: COLORS.gray200 } },
  left: { style: 'thin', color: { argb: COLORS.gray200 } },
  right: { style: 'thin', color: { argb: COLORS.gray200 } },
};

// ── Types ──────────────────────────────────────────────────────────────

interface CardData {
  title: string;
  description: string;
  column: string;
  assignee: string;
  createdAt: Date;
  dueDate: Date | null;
  daysRemaining: number | null;
  status: 'overdue' | 'today' | 'upcoming' | 'none';
  hasNote: boolean;
  commentCount: number;
}

// ── Main export ────────────────────────────────────────────────────────

export async function exportGanttXLSX(
  board: KanbanBoard,
  t: (key: string, opts?: Record<string, unknown>) => string,
  language: string,
): Promise<void> {
  const locale = language.startsWith('it') ? itLocale : enUS;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Notiq';
  workbook.created = new Date();

  // Collect card data
  const allCards: CardData[] = [];
  const columns = [...board.columns].sort((a, b) => a.position - b.position);

  for (const col of columns) {
    const sorted = [...col.cards].sort((a, b) => a.position - b.position);
    for (const card of sorted) {
      const dueDate = card.dueDate ? startOfDay(new Date(card.dueDate)) : null;
      const today = startOfDay(new Date());
      let status: CardData['status'] = 'none';
      let daysRemaining: number | null = null;

      if (dueDate) {
        daysRemaining = differenceInDays(dueDate, today);
        if (isDateToday(dueDate)) status = 'today';
        else if (isDatePast(dueDate)) status = 'overdue';
        else status = 'upcoming';
      }

      allCards.push({
        title: card.title,
        description: card.description || '',
        column: col.title,
        assignee: card.assignee?.name || card.assignee?.email || '',
        createdAt: startOfDay(new Date(card.createdAt)),
        dueDate,
        daysRemaining,
        status,
        hasNote: !!card.noteId,
        commentCount: card.commentCount,
      });
    }
  }

  const cardsWithDue = allCards.filter((c) => c.dueDate !== null);
  const overdue = allCards.filter((c) => c.status === 'overdue');
  const dueToday = allCards.filter((c) => c.status === 'today');
  const upcoming = allCards.filter((c) => c.status === 'upcoming');

  // ── Sheet 1: Overview ──────────────────────────────────────────────
  createOverviewSheet(workbook, board, allCards, columns, overdue, dueToday, upcoming, cardsWithDue, t, locale);

  // ── Sheet 2: Gantt Chart ───────────────────────────────────────────
  if (cardsWithDue.length > 0) {
    createGanttSheet(workbook, cardsWithDue, t, locale);
  }

  // ── Sheet 3: All Cards ─────────────────────────────────────────────
  createAllCardsSheet(workbook, allCards, t, locale);

  // Download
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${board.title.replace(/[^a-zA-Z0-9_-]/g, '-')}-gantt.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sheet 1: Overview ──────────────────────────────────────────────────

function createOverviewSheet(
  workbook: ExcelJS.Workbook,
  board: KanbanBoard,
  allCards: CardData[],
  columns: KanbanBoard['columns'],
  overdue: CardData[],
  dueToday: CardData[],
  upcoming: CardData[],
  cardsWithDue: CardData[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: Locale,
): void {
  const ws = workbook.addWorksheet(t('kanban.export.sheetOverview'), {
    properties: { tabColor: { argb: COLORS.emerald600 } },
  });

  ws.columns = [{ width: 28 }, { width: 20 }, { width: 15 }];

  // Title
  const titleRow = ws.addRow([board.title]);
  titleRow.font = { size: 20, bold: true, color: { argb: COLORS.emerald600 } };
  titleRow.height = 32;
  ws.mergeCells('A1:C1');

  // Export date
  ws.addRow([]);
  const dateRow = ws.addRow([
    t('kanban.export.exportDate'),
    format(new Date(), 'PPP', { locale }),
  ]);
  dateRow.getCell(1).font = { bold: true, color: { argb: COLORS.gray600 } };
  dateRow.getCell(2).font = { color: { argb: COLORS.gray800 } };

  // Stats section
  ws.addRow([]);
  const statsHeader = ws.addRow([t('kanban.export.statistics')]);
  statsHeader.font = { size: 14, bold: true, color: { argb: COLORS.gray800 } };

  const stats: [string, number, string][] = [
    [t('kanban.export.totalCards'), allCards.length, COLORS.gray800],
    [t('kanban.export.withDueDate'), cardsWithDue.length, COLORS.blue600],
    [t('kanban.export.overdueCards'), overdue.length, COLORS.red600],
    [t('kanban.export.dueTodayCards'), dueToday.length, COLORS.amber600],
    [t('kanban.export.upcomingCards'), upcoming.length, COLORS.emerald600],
    [t('kanban.export.noDueDate'), allCards.length - cardsWithDue.length, COLORS.gray400],
  ];

  for (const [label, value, color] of stats) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { color: { argb: COLORS.gray600 } };
    row.getCell(2).font = { bold: true, size: 12, color: { argb: color } };
    row.getCell(2).alignment = { horizontal: 'left' };
  }

  // Columns breakdown
  ws.addRow([]);
  const colHeader = ws.addRow([t('kanban.export.columnBreakdown')]);
  colHeader.font = { size: 14, bold: true, color: { argb: COLORS.gray800 } };

  for (const col of columns) {
    const row = ws.addRow([col.title, col.cards.length]);
    row.getCell(1).font = { color: { argb: COLORS.gray600 } };
    row.getCell(2).font = { bold: true, color: { argb: COLORS.emerald600 } };
  }
}

// ── Sheet 2: Gantt Chart ───────────────────────────────────────────────

function createGanttSheet(
  workbook: ExcelJS.Workbook,
  cardsWithDue: CardData[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: Locale,
): void {
  const ws = workbook.addWorksheet(t('kanban.export.sheetGantt'), {
    properties: { tabColor: { argb: COLORS.emerald600 } },
  });

  // Compute date range
  const allDates = cardsWithDue.flatMap((c) => [c.createdAt, c.dueDate!]);
  const minDate = startOfDay(
    allDates.reduce((min, d) => (d < min ? d : min), allDates[0]),
  );
  const maxDate = startOfDay(
    allDates.reduce((max, d) => (d > max ? d : max), allDates[0]),
  );

  const days = eachDayOfInterval({ start: minDate, end: maxDate });

  // Cap at 120 days for readability
  const displayDays = days.length > 120 ? days.slice(days.length - 120) : days;

  // Fixed columns
  const fixedCols = [
    { key: 'title', header: t('kanban.export.cardTitle'), width: 28 },
    { key: 'column', header: t('kanban.export.column'), width: 14 },
    { key: 'assignee', header: t('kanban.export.assignee'), width: 16 },
    { key: 'start', header: t('kanban.export.startDate'), width: 12 },
    { key: 'due', header: t('kanban.export.dueDate'), width: 12 },
    { key: 'days', header: t('kanban.export.daysRemaining'), width: 10 },
  ];

  // Day columns
  const dayColumns = displayDays.map((day, i) => ({
    key: `d${i}`,
    header: format(day, 'dd', { locale }),
    width: 4,
  }));

  ws.columns = [...fixedCols, ...dayColumns].map((c) => ({
    key: c.key,
    width: c.width,
  }));

  // ── Header row 1: Month names spanning across day columns ──────────
  const monthRow = ws.addRow([]);
  // Leave fixed columns empty
  for (let i = 0; i < fixedCols.length; i++) {
    monthRow.getCell(i + 1).value = '';
  }

  // Group days by month
  let monthStart = 0;
  for (let i = 0; i < displayDays.length; i++) {
    const isLast = i === displayDays.length - 1;
    const nextDifferentMonth =
      !isLast &&
      displayDays[i].getMonth() !== displayDays[i + 1].getMonth();

    if (nextDifferentMonth || isLast) {
      const colStart = fixedCols.length + monthStart + 1;
      const colEnd = fixedCols.length + i + 1;
      const monthName = format(displayDays[monthStart], 'MMMM yyyy', { locale });

      if (colStart === colEnd) {
        monthRow.getCell(colStart).value = monthName;
      } else {
        ws.mergeCells(1, colStart, 1, colEnd);
        monthRow.getCell(colStart).value = monthName;
      }

      monthRow.getCell(colStart).font = {
        bold: true,
        size: 10,
        color: { argb: COLORS.white },
      };
      monthRow.getCell(colStart).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: COLORS.emerald600 },
      };
      monthRow.getCell(colStart).alignment = { horizontal: 'center' };

      monthStart = i + 1;
    }
  }

  // ── Header row 2: Fixed headers + day numbers ──────────────────────
  const headerValues = [
    ...fixedCols.map((c) => c.header),
    ...dayColumns.map((c) => c.header),
  ];
  const headerRow = ws.addRow(headerValues);
  headerRow.height = 22;

  for (let i = 1; i <= headerValues.length; i++) {
    const cell = headerRow.getCell(i);
    cell.font = { bold: true, size: 10, color: { argb: COLORS.white } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLORS.emerald600 },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN_BORDER;

    // Highlight today column header
    if (i > fixedCols.length) {
      const dayIdx = i - fixedCols.length - 1;
      if (displayDays[dayIdx] && isDateToday(displayDays[dayIdx])) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLORS.todayMarker },
        };
        cell.font = { bold: true, size: 10, color: { argb: COLORS.amber400 } };
      }
    }
  }

  // Freeze panes: fix first 2 rows + first 6 columns
  ws.views = [{ state: 'frozen', xSplit: fixedCols.length, ySplit: 2 }];

  // ── Data rows ──────────────────────────────────────────────────────
  // Sort by dueDate
  const sorted = [...cardsWithDue].sort(
    (a, b) => a.dueDate!.getTime() - b.dueDate!.getTime(),
  );

  for (let rowIdx = 0; rowIdx < sorted.length; rowIdx++) {
    const card = sorted[rowIdx];
    const isZebra = rowIdx % 2 === 1;

    const rowValues = [
      card.title,
      card.column,
      card.assignee,
      format(card.createdAt, 'yyyy-MM-dd'),
      format(card.dueDate!, 'yyyy-MM-dd'),
      card.daysRemaining,
    ];

    // Fill day cells
    for (let di = 0; di < displayDays.length; di++) {
      const day = displayDays[di];
      const inRange = isWithinInterval(day, {
        start: card.createdAt,
        end: card.dueDate!,
      });
      rowValues.push(inRange ? '' : undefined as unknown as string);
    }

    const row = ws.addRow(rowValues);

    // Style fixed cells
    for (let i = 1; i <= fixedCols.length; i++) {
      const cell = row.getCell(i);
      cell.border = THIN_BORDER;
      cell.font = { size: 10 };

      if (isZebra) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLORS.gray50 },
        };
      }

      // Title column bold
      if (i === 1) cell.font = { size: 10, bold: true };

      // Days remaining color
      if (i === fixedCols.length && card.daysRemaining !== null) {
        if (card.status === 'overdue') {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.red600 } };
        } else if (card.status === 'today') {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.amber600 } };
        } else {
          cell.font = { size: 10, color: { argb: COLORS.emerald600 } };
        }
        cell.alignment = { horizontal: 'center' };
      }
    }

    // Style day cells (Gantt bars)
    for (let di = 0; di < displayDays.length; di++) {
      const cellIdx = fixedCols.length + di + 1;
      const cell = row.getCell(cellIdx);
      const day = displayDays[di];

      const inRange =
        card.dueDate &&
        isWithinInterval(day, { start: card.createdAt, end: card.dueDate });

      if (inRange) {
        let barColor = COLORS.green100;
        if (card.status === 'overdue') barColor = COLORS.red100;
        else if (card.status === 'today') barColor = COLORS.amber100;

        // Due date cell gets a stronger color
        if (isSameDay(day, card.dueDate!)) {
          if (card.status === 'overdue') barColor = COLORS.red400;
          else if (card.status === 'today') barColor = COLORS.amber400;
          else barColor = COLORS.green400;
        }

        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: barColor },
        };
      } else if (isZebra) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLORS.gray50 },
        };
      }

      // Today column vertical line
      if (isDateToday(day)) {
        cell.border = {
          ...THIN_BORDER,
          left: { style: 'medium', color: { argb: COLORS.amber600 } },
          right: { style: 'medium', color: { argb: COLORS.amber600 } },
        };
      }
    }
  }
}

// ── Sheet 3: All Cards ─────────────────────────────────────────────────

function createAllCardsSheet(
  workbook: ExcelJS.Workbook,
  allCards: CardData[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: Locale,
): void {
  const ws = workbook.addWorksheet(t('kanban.export.sheetAllCards'), {
    properties: { tabColor: { argb: COLORS.blue600 } },
  });

  const headers = [
    { key: 'title', header: t('kanban.export.cardTitle'), width: 30 },
    { key: 'description', header: t('kanban.export.description'), width: 40 },
    { key: 'column', header: t('kanban.export.column'), width: 14 },
    { key: 'assignee', header: t('kanban.export.assignee'), width: 16 },
    { key: 'created', header: t('kanban.export.createdAt'), width: 12 },
    { key: 'dueDate', header: t('kanban.export.dueDate'), width: 12 },
    { key: 'days', header: t('kanban.export.daysRemaining'), width: 10 },
    { key: 'note', header: t('kanban.export.hasNote'), width: 10 },
    { key: 'comments', header: t('kanban.export.commentCount'), width: 12 },
  ];

  ws.columns = headers.map((h) => ({ key: h.key, width: h.width }));

  // Header row
  const headerRow = ws.addRow(headers.map((h) => h.header));
  headerRow.height = 24;
  for (let i = 1; i <= headers.length; i++) {
    const cell = headerRow.getCell(i);
    cell.font = { bold: true, size: 10, color: { argb: COLORS.white } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLORS.emerald600 },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN_BORDER;
  }

  // Freeze header
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  // Data rows
  for (let rowIdx = 0; rowIdx < allCards.length; rowIdx++) {
    const card = allCards[rowIdx];
    const isZebra = rowIdx % 2 === 1;

    const row = ws.addRow([
      card.title,
      card.description,
      card.column,
      card.assignee,
      format(card.createdAt, 'yyyy-MM-dd'),
      card.dueDate ? format(card.dueDate, 'yyyy-MM-dd') : '',
      card.daysRemaining,
      card.hasNote ? '✓' : '',
      card.commentCount || '',
    ]);

    for (let i = 1; i <= headers.length; i++) {
      const cell = row.getCell(i);
      cell.border = THIN_BORDER;
      cell.font = { size: 10 };

      if (isZebra) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLORS.gray50 },
        };
      }

      // Title bold
      if (i === 1) cell.font = { size: 10, bold: true };

      // Status-based coloring for the row
      if (card.status === 'overdue') {
        if (i === 6 || i === 7) {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.red600 } };
        }
        if (i === 1) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: COLORS.red100 },
          };
        }
      } else if (card.status === 'today') {
        if (i === 6 || i === 7) {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.amber600 } };
        }
        if (i === 1) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: COLORS.amber100 },
          };
        }
      }

      // "Has note" checkmark green
      if (i === 8 && card.hasNote) {
        cell.font = { size: 10, color: { argb: COLORS.emerald600 } };
        cell.alignment = { horizontal: 'center' };
      }

      // Comment count centered
      if (i === 9) cell.alignment = { horizontal: 'center' };

      // Days remaining color + center
      if (i === 7 && card.daysRemaining !== null) {
        cell.alignment = { horizontal: 'center' };
        if (card.status === 'overdue') {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.red600 } };
        } else if (card.status === 'today') {
          cell.font = { size: 10, bold: true, color: { argb: COLORS.amber600 } };
        } else {
          cell.font = { size: 10, color: { argb: COLORS.emerald600 } };
        }
      }
    }
  }

  // Auto-filter
  if (allCards.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: allCards.length + 1, column: headers.length },
    };
  }
}
