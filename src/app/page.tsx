// Lightweight dashboard for reviewers.
//
// We deliberately keep this small — the assignment says "perfect UI is not
// what we care about". What reviewers do need is:
//   - a way to upload
//   - a list of jobs with status
//   - a way to drill into a job and see per-check verdicts + details
"use client";

import { useEffect, useRef, useState } from "react";

type CheckResult = {
  name: string;
  verdict: "pass" | "warn" | "fail";
  confidence: number;
  details: Record<string, unknown> | null;
  createdAt: string;
};

type JobListItem = {
  id: string;
  imageId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  workerId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

type JobView = JobListItem & {
  jobId: string;
  overall: { verdict: "pass" | "warn" | "fail"; confidence: number };
  image: {
    id: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    sha256: string;
    phash: string | null;
    uploadedAt: string;
  } | null;
  checks: CheckResult[];
};

type StatsView = {
  totals: { jobs: number; images: number };
  byStatus: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  byCheck: {
    checkName: string;
    total: number;
    pass: number;
    warn: number;
    fail: number;
  }[];
};

function verdictColor(v: string) {
  if (v === "pass") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (v === "warn") return "bg-amber-100 text-amber-800 border-amber-200";
  if (v === "fail") return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function statusDot(s: string) {
  if (s === "completed") return "bg-emerald-500";
  if (s === "failed") return "bg-rose-500";
  if (s === "processing") return "bg-blue-500 animate-pulse";
  return "bg-slate-400";
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Page() {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [selected, setSelected] = useState<JobView | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [list, s] = await Promise.all([
      fetch("/api/images", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setJobs(list.jobs);
    setStats(s);
    if (selected) {
      const j = await fetch(`/api/jobs/${selected.jobId}`, { cache: "no-store" }).then(
        (r) => r.json(),
      );
      setSelected(j);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.jobId]);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploadError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/images", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `upload failed: ${res.status}`);
      }
      const j = await res.json();
      // Open the new job immediately.
      const detail = await fetch(`/api/jobs/${j.jobId}`).then((r) => r.json());
      setSelected(detail);
      await refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Vehicle Image Pipeline</h1>
            <p className="text-xs text-slate-500">
              Async upload → analysis → verdicts with confidence
            </p>
          </div>
          <form
            onSubmit={onUpload}
            className="flex items-center gap-2"
            data-testid="upload-form"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-slate-900 file:text-white file:cursor-pointer"
            />
            <button
              type="submit"
              disabled={uploading}
              className="text-xs bg-slate-900 text-white px-3 py-1.5 rounded disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </form>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {uploadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {uploadError}
          </div>
        )}

        {stats && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Jobs" value={stats.totals.jobs} />
            <Stat label="Images" value={stats.totals.images} />
            <Stat label="Pending" value={stats.byStatus.pending} />
            <Stat label="Processing" value={stats.byStatus.processing} />
            <Stat
              label="Completed"
              value={stats.byStatus.completed}
              sub={`${stats.byStatus.failed} failed`}
            />
          </section>
        )}

        {stats && stats.byCheck.length > 0 && (
          <section className="bg-white border border-slate-200 rounded p-4">
            <h2 className="text-sm font-semibold mb-3">Checks overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {stats.byCheck.map((c) => (
                <div
                  key={c.checkName}
                  className="border border-slate-200 rounded p-2"
                >
                  <div className="font-mono">{c.checkName}</div>
                  <div className="text-slate-500">
                    pass {c.pass} · warn {c.warn} · fail {c.fail}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="text-sm font-semibold mb-2">Recent jobs</h2>
            <div className="bg-white border border-slate-200 rounded divide-y">
              {jobs.length === 0 && (
                <div className="p-4 text-sm text-slate-500">
                  No jobs yet — upload an image to begin.
                </div>
              )}
              {jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() =>
                    fetch(`/api/jobs/${j.id}`).then((r) => r.json()).then(setSelected)
                  }
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-3 hover:bg-slate-50 ${
                    selected?.jobId === j.id ? "bg-slate-50" : ""
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${statusDot(j.status)}`} />
                  <span className="font-mono text-xs text-slate-500 truncate w-24">
                    {j.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate text-slate-700">
                    {j.imageId.slice(0, 8)}
                  </span>
                  <span className="text-xs text-slate-500">{j.status}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold mb-2">Job detail</h2>
            {selected ? (
              <JobDetail job={selected} />
            ) : (
              <div className="bg-white border border-slate-200 rounded p-4 text-sm text-slate-500">
                Select a job to view its checks.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function JobDetail({ job }: { job: JobView }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-4 space-y-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-xs px-2 py-0.5 rounded border ${verdictColor(job.overall.verdict)}`}
        >
          overall: {job.overall.verdict} ({job.overall.confidence.toFixed(2)})
        </span>
        <span className="text-xs text-slate-500">
          status: {job.status} · attempts {job.attempts}/{job.maxAttempts}
          {job.workerId ? ` · ${job.workerId}` : ""}
        </span>
      </div>

      {job.image && (
        <div className="grid grid-cols-2 gap-3">
          <img
            src={`/api/images/${job.image.id}/file`}
            alt="upload"
            className="rounded border border-slate-200 max-h-64 object-contain bg-slate-100"
          />
          <div className="text-xs text-slate-600 space-y-1">
            <div>
              <span className="text-slate-400">filename:</span>{" "}
              {job.image.originalFilename}
            </div>
            <div>
              <span className="text-slate-400">size:</span>{" "}
              {fmtBytes(job.image.sizeBytes)}
            </div>
            <div>
              <span className="text-slate-400">dimensions:</span>{" "}
              {job.image.width ?? "?"}×{job.image.height ?? "?"}
            </div>
            <div className="break-all">
              <span className="text-slate-400">sha256:</span> {job.image.sha256}
            </div>
            <div>
              <span className="text-slate-400">phash:</span>{" "}
              {job.image.phash || "—"}
            </div>
            {job.error && (
              <div className="text-rose-700">
                <span className="text-slate-400">error:</span> {job.error}
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">
          Checks
        </h3>
        <div className="space-y-2">
          {job.checks.length === 0 && (
            <div className="text-xs text-slate-500">
              No checks yet — job is {job.status}.
            </div>
          )}
          {job.checks.map((c) => (
            <div
              key={c.name}
              className="border border-slate-200 rounded p-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 rounded border ${verdictColor(c.verdict)}`}
                >
                  {c.verdict}
                </span>
                <span className="font-mono">{c.name}</span>
                <span className="ml-auto text-slate-500">
                  conf {c.confidence.toFixed(2)}
                </span>
              </div>
              {c.details && (
                <pre className="mt-1 bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto text-[10px]">
                  {JSON.stringify(c.details, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
