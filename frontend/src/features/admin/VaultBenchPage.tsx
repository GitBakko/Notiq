import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Copy, Play, Square } from 'lucide-react';
import clsx from 'clsx';
import { DEFAULT_KDF, deriveS, resetArgon2Worker } from '../../utils/argon2';
import { useAuthStore } from '../../store/authStore';
import packageJson from '../../../package.json';

// Benchmark Argon2id (D4/D13): solo SUPERADMIN, nessuna rete, nessuno storage.
const PIN = 'k7Rq2x';
const T_MIN = 3;
const T_MAX = 10;
const WARM_N = 20;
const COLD_N = 3;
const WARM_P95_MAX_MS = 1500;
const COLD_MAX_MS = 2000;
const YIELD_MS = 250;

interface Row {
  t: number;
  n: number;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  warm: number[];
  cold: { samples: number[]; worst: number | null };
  errors: number;
  retries: number;
  violated: boolean;
}

type Status = 'idle' | 'running' | 'done' | 'stopped' | 'violated';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const round = (x: number) => Math.round(x * 10) / 10;

// Nearest-rank: con n=20 il 95 percentile e' il 19o valore ordinato.
function summarize(row: Row) {
  const s = [...row.warm].sort((a, b) => a - b);
  const n = s.length;
  row.n = n;
  row.min = n ? s[0] : null;
  row.max = n ? s[n - 1] : null;
  row.p95 = n ? s[Math.ceil(0.95 * n) - 1] : null;
  row.median = n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
  row.cold.worst = row.cold.samples.length ? Math.max(...row.cold.samples) : null;
}

function findEntry(): string {
  const src = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? '';
  return /index-[^/]*\.js/.exec(src)?.[0] ?? '';
}

function guessIos(): string {
  return /OS (\d+(?:[_.]\d+)*)/.exec(navigator.userAgent)?.[1].replace(/_/g, '.') ?? '';
}

function Bench() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [model, setModel] = useState('');
  const [ios, setIos] = useState(guessIos);
  const [copied, setCopied] = useState<'ok' | 'ko' | null>(null);
  const stopRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Smontaggio a meta corsa: il ciclo esce al prossimo controllo e non lancia altre derivazioni.
  useEffect(() => () => { stopRef.current = true; }, []);

  const secure = typeof window !== 'undefined' && window.isSecureContext && !!globalThis.crypto?.subtle;
  const standalone = useMemo(
    () => !!window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    [],
  );
  const entry = useMemo(() => findEntry(), []);

  const json = useMemo(
    () => JSON.stringify({
      app: packageJson.version, entry, DEFAULT_KDF, standalone,
      userAgent: navigator.userAgent, model, ios, status,
      results: rows.map((r) => ({
        t: r.t, n: r.n, median: r.median, p95: r.p95, min: r.min, max: r.max,
        cold: r.cold, errors: r.errors, retries: r.retries, violated: r.violated,
        warm: r.warm,
      })),
    }, null, 2),
    [rows, entry, standalone, model, ios, status],
  );

  const run = async () => {
    stopRef.current = false;
    setStatus('running');
    setRows([]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const all: Row[] = [];
    const publish = () => setRows(all.map((r) => ({ ...r })));
    let final: Status = 'done';

    outer:
    for (let tt = T_MIN; tt <= T_MAX; tt++) {
      const params = { ...DEFAULT_KDF, t: tt };
      const row: Row = {
        t: tt, n: 0, median: null, p95: null, min: null, max: null, warm: [],
        cold: { samples: [], worst: null }, errors: 0, retries: 0, violated: false,
      };
      all.push(row);
      const time = async () => {
        const t0 = performance.now();
        await deriveS(PIN, salt, params);
        return round(performance.now() - t0);
      };

      // Freddo: Worker ricreato prima di ogni campione; un solo retry su errore.
      for (let i = 0; i < COLD_N; i++) {
        if (stopRef.current) { final = 'stopped'; break outer; }
        let ms: number | null = null;
        for (let attempt = 0; attempt < 2 && ms === null; attempt++) {
          resetArgon2Worker();
          await sleep(YIELD_MS);
          if (stopRef.current) break;
          try { ms = await time(); } catch { if (stopRef.current) break; if (attempt === 0) row.retries++; }
        }
        // Stop (anche via reset del Worker in volo): non e' un errore di misura.
        if (ms === null && stopRef.current) { final = 'stopped'; break outer; }
        if (ms === null) row.errors++; else row.cold.samples.push(ms);
        summarize(row); publish();
        if (ms === null) break;
      }

      // Caldo: il Worker creato dall'ultimo campione a freddo e' gia' pronto.
      if (!row.errors) {
        for (let i = 0; i < WARM_N; i++) {
          if (stopRef.current) { final = 'stopped'; break outer; }
          try {
            row.warm.push(await time());
          } catch {
            if (stopRef.current) { final = 'stopped'; break outer; }
            row.errors++; summarize(row); publish(); break;
          }
          summarize(row); publish();
        }
      }

      summarize(row);
      row.violated = row.errors > 0
        || (row.p95 ?? 0) > WARM_P95_MAX_MS
        || (row.cold.worst ?? 0) > COLD_MAX_MS;
      publish();
      if (row.violated) { final = 'violated'; break; }
    }
    setStatus(final);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied('ok');
    } catch {
      const ta = taRef.current;
      if (ta) { ta.select(); setCopied(document.execCommand('copy') ? 'ok' : 'ko'); } else setCopied('ko');
    }
  };

  const running = status === 'running';
  const btn = 'inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] px-4 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const field = 'min-h-[44px] w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100';

  return (
    <div className="min-h-screen bg-neutral-50 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 min-h-[44px] text-sm text-emerald-700 dark:text-emerald-400"
        >
          <ArrowLeft size={18} /> {t('vaultBench.back')}
        </Link>
        <h1 className="text-xl font-bold">{t('vaultBench.title')}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('vaultBench.intro')}</p>

        {!secure && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {t('vaultBench.insecure')}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            {t('vaultBench.model')}
            <input className={field} value={model} onChange={(e) => setModel(e.target.value)} disabled={running} />
          </label>
          <label className="text-sm">
            {t('vaultBench.ios')}
            <input className={field} value={ios} onChange={(e) => setIos(e.target.value)} disabled={running} />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={clsx(btn, 'bg-emerald-600 text-white hover:bg-emerald-700')}
            onClick={run}
            disabled={!secure || running}
            aria-label={t('vaultBench.start')}
          >
            <Play size={16} /> {t('vaultBench.start')}
          </button>
          <button
            type="button"
            className={clsx(btn, 'bg-neutral-200 text-neutral-900 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600')}
            onClick={() => { stopRef.current = true; resetArgon2Worker(); }}
            disabled={!running}
            aria-label={t('vaultBench.stop')}
          >
            <Square size={16} /> {t('vaultBench.stop')}
          </button>
          <button
            type="button"
            className={clsx(btn, 'bg-neutral-200 text-neutral-900 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600')}
            onClick={copy}
            aria-label={t('vaultBench.copy')}
          >
            <Copy size={16} /> {t('vaultBench.copy')}
          </button>
          <span role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
            {t(`vaultBench.status.${status}`)}
            {copied === 'ok' && ` · ${t('vaultBench.copied')}`}
            {copied === 'ko' && ` · ${t('vaultBench.copyFailed')}`}
          </span>
        </div>

        <textarea
          ref={taRef}
          readOnly
          value={json}
          aria-label={t('vaultBench.output')}
          className="h-96 w-full rounded-lg border border-neutral-300 bg-white p-3 font-mono text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </div>
    </div>
  );
}

export default function VaultBenchPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'SUPERADMIN') return <Navigate to="/notes" replace />;
  return <Bench />;
}
