import { ChevronsUp, ChevronUp, Minus, ChevronDown, Pause } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Shared priority levels — superset used by Kanban; Task lists use LOW/MEDIUM/HIGH subset */
export type PriorityLevel = 'STANDBY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const PRIORITY_CONFIG: Record<PriorityLevel, { icon: LucideIcon; color: string }> = {
  STANDBY: { icon: Pause, color: 'text-neutral-400 dark:text-neutral-500' },
  LOW: { icon: ChevronDown, color: 'text-blue-500 dark:text-blue-400' },
  MEDIUM: { icon: Minus, color: 'text-yellow-500 dark:text-yellow-400' },
  HIGH: { icon: ChevronUp, color: 'text-orange-500 dark:text-orange-400' },
  CRITICAL: { icon: ChevronsUp, color: 'text-red-500 dark:text-red-400' },
};
