/**
 * In-memory request metrics collector.
 * Rolling 60-minute window with per-minute buckets.
 * No external dependencies — metrics reset on server restart.
 */

interface RouteStat {
  count: number;
  errors4xx: number;
  errors5xx: number;
  totalMs: number;
  maxMs: number;
  responseTimes: number[]; // kept for p95 calculation (capped per bucket)
}

interface MinuteBucket {
  timestamp: number; // minute-aligned epoch ms
  requestCount: number;
  errors4xx: number;
  errors5xx: number;
  totalResponseMs: number;
  maxResponseMs: number;
  routes: Map<string, RouteStat>;
}

export interface AggregatedMetrics {
  windowMinutes: number;
  requestCount: number;
  errors4xx: number;
  errors5xx: number;
  errorRate: number;
  avgResponseMs: number;
  maxResponseMs: number;
  requestsPerMinute: number;
  timeline: { minute: string; requests: number; errors: number }[];
}

export interface RouteMetric {
  route: string;
  method: string;
  count: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  p95Ms: number;
}

const MAX_WINDOW_MINUTES = 60;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune every 5 min
const MAX_RESPONSE_TIMES_PER_BUCKET = 200; // cap per route per bucket for p95

class MetricsCollector {
  private buckets = new Map<number, MinuteBucket>();
  private startTime = Date.now();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Don't prevent process exit
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  private getMinuteKey(now = Date.now()): number {
    return Math.floor(now / 60000) * 60000;
  }

  private getBucket(minuteKey: number): MinuteBucket {
    let bucket = this.buckets.get(minuteKey);
    if (!bucket) {
      bucket = {
        timestamp: minuteKey,
        requestCount: 0,
        errors4xx: 0,
        errors5xx: 0,
        totalResponseMs: 0,
        maxResponseMs: 0,
        routes: new Map(),
      };
      this.buckets.set(minuteKey, bucket);
    }
    return bucket;
  }

  recordRequest(route: string, method: string, statusCode: number, responseTimeMs: number): void {
    const bucket = this.getBucket(this.getMinuteKey());
    bucket.requestCount++;
    bucket.totalResponseMs += responseTimeMs;
    if (responseTimeMs > bucket.maxResponseMs) bucket.maxResponseMs = responseTimeMs;

    const is4xx = statusCode >= 400 && statusCode < 500;
    const is5xx = statusCode >= 500;
    if (is4xx) bucket.errors4xx++;
    if (is5xx) bucket.errors5xx++;

    // Per-route stats
    const routeKey = `${method} ${route}`;
    let routeStat = bucket.routes.get(routeKey);
    if (!routeStat) {
      routeStat = { count: 0, errors4xx: 0, errors5xx: 0, totalMs: 0, maxMs: 0, responseTimes: [] };
      bucket.routes.set(routeKey, routeStat);
    }
    routeStat.count++;
    routeStat.totalMs += responseTimeMs;
    if (responseTimeMs > routeStat.maxMs) routeStat.maxMs = responseTimeMs;
    if (is4xx) routeStat.errors4xx++;
    if (is5xx) routeStat.errors5xx++;
    if (routeStat.responseTimes.length < MAX_RESPONSE_TIMES_PER_BUCKET) {
      routeStat.responseTimes.push(responseTimeMs);
    }
  }

  getMetrics(windowMinutes = 60): AggregatedMetrics {
    const now = Date.now();
    const cutoff = now - windowMinutes * 60000;
    let requestCount = 0;
    let errors4xx = 0;
    let errors5xx = 0;
    let totalMs = 0;
    let maxMs = 0;
    const timeline: { minute: string; requests: number; errors: number }[] = [];

    for (const [key, bucket] of this.buckets) {
      if (key < cutoff) continue;
      requestCount += bucket.requestCount;
      errors4xx += bucket.errors4xx;
      errors5xx += bucket.errors5xx;
      totalMs += bucket.totalResponseMs;
      if (bucket.maxResponseMs > maxMs) maxMs = bucket.maxResponseMs;

      timeline.push({
        minute: new Date(bucket.timestamp).toISOString(),
        requests: bucket.requestCount,
        errors: bucket.errors4xx + bucket.errors5xx,
      });
    }

    timeline.sort((a, b) => a.minute.localeCompare(b.minute));

    return {
      windowMinutes,
      requestCount,
      errors4xx,
      errors5xx,
      errorRate: requestCount > 0 ? (errors4xx + errors5xx) / requestCount : 0,
      avgResponseMs: requestCount > 0 ? Math.round(totalMs / requestCount) : 0,
      maxResponseMs: Math.round(maxMs),
      requestsPerMinute: windowMinutes > 0 ? Math.round((requestCount / windowMinutes) * 10) / 10 : 0,
      timeline,
    };
  }

  getRouteMetrics(windowMinutes = 60): RouteMetric[] {
    const now = Date.now();
    const cutoff = now - windowMinutes * 60000;

    // Aggregate across buckets
    const agg = new Map<string, { count: number; errors: number; totalMs: number; maxMs: number; responseTimes: number[] }>();

    for (const [key, bucket] of this.buckets) {
      if (key < cutoff) continue;
      for (const [routeKey, stat] of bucket.routes) {
        let entry = agg.get(routeKey);
        if (!entry) {
          entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, responseTimes: [] };
          agg.set(routeKey, entry);
        }
        entry.count += stat.count;
        entry.errors += stat.errors4xx + stat.errors5xx;
        entry.totalMs += stat.totalMs;
        if (stat.maxMs > entry.maxMs) entry.maxMs = stat.maxMs;
        // Sample response times for p95 (cap total)
        for (const t of stat.responseTimes) {
          if (entry.responseTimes.length < 1000) entry.responseTimes.push(t);
        }
      }
    }

    const results: RouteMetric[] = [];
    for (const [routeKey, stat] of agg) {
      const spaceIdx = routeKey.indexOf(' ');
      const method = routeKey.slice(0, spaceIdx);
      const route = routeKey.slice(spaceIdx + 1);

      // Calculate p95
      stat.responseTimes.sort((a, b) => a - b);
      const p95Idx = Math.floor(stat.responseTimes.length * 0.95);
      const p95 = stat.responseTimes[p95Idx] ?? 0;

      results.push({
        route,
        method,
        count: stat.count,
        errors: stat.errors,
        avgMs: Math.round(stat.totalMs / stat.count),
        maxMs: Math.round(stat.maxMs),
        p95Ms: Math.round(p95),
      });
    }

    // Sort by avg response time descending (slowest first)
    results.sort((a, b) => b.avgMs - a.avgMs);
    return results;
  }

  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number; external: number } {
    const mem = process.memoryUsage();
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_WINDOW_MINUTES * 60000;
    for (const key of this.buckets.keys()) {
      if (key < cutoff) this.buckets.delete(key);
    }
  }

  /** For testing */
  reset(): void {
    this.buckets.clear();
    this.startTime = Date.now();
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
  }
}

// Singleton instance
export const metrics = new MetricsCollector();
