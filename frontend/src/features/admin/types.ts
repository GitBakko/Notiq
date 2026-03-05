export interface DashboardStats {
  kpi: {
    totalUsers: number;
    activeUsers: number;
    totalNotes: number;
    totalNotebooks: number;
    totalStorageBytes: number;
    totalAttachments: number;
    avgNotesPerUser: number;
    totalTags: number;
    totalSharedNotes: number;
    totalSharedNotebooks: number;
    vaultUsersCount: number;
  };
  charts: {
    registrationHistory: { date: string; count: number }[];
    notesHistory: { date: string; count: number }[];
    storageByType: { name: string; value: number }[];
    sharingHistory: { date: string; count: number }[];
  };
  recentUsers: UserData[];
}

export interface UserData {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastActiveAt: string;
  role: 'USER' | 'SUPERADMIN';
  isVerified: boolean;
  _count?: { notes: number };
}

export interface AuditLog {
  id: string;
  event: string;
  createdAt: string;
  user: { email: string; name?: string | null };
  details: Record<string, unknown>;
}

export interface AuditStats {
  eventCounts: { event: string; count: number }[];
  dailyTimeline: { date: string; count: number }[];
  eventTypes: string[];
}

export interface SystemHealth {
  uptime: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  connections: {
    websocket: number;
    sse: number;
  };
  database: {
    status: string;
  };
  metrics: {
    windowMinutes: number;
    requestCount: number;
    errors4xx: number;
    errors5xx: number;
    errorRate: number;
    avgResponseMs: number;
    maxResponseMs: number;
    requestsPerMinute: number;
    timeline: { minute: string; requests: number; errors: number }[];
  };
}

export interface MetricsData {
  windowMinutes: number;
  requestCount: number;
  errors4xx: number;
  errors5xx: number;
  errorRate: number;
  avgResponseMs: number;
  maxResponseMs: number;
  requestsPerMinute: number;
  timeline: { minute: string; requests: number; errors: number }[];
  routes: {
    route: string;
    method: string;
    count: number;
    errors: number;
    avgMs: number;
    maxMs: number;
    p95Ms: number;
  }[];
}

export const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8'];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
