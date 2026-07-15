"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  TerminalSquare,
  Terminal,
  Loader2,
  CircleDashed,
  ExternalLink,
  Sparkles,
  Table,
  Folder,
  Database,
  ShieldCheck,
  RotateCw,
  TriangleAlert,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/cn";

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
};

type Mode = "cli" | "key" | "manual";
type Tab = "engine" | "integrations";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google (Gemini)" },
  { id: "openrouter", label: "OpenRouter" },
] as const;

const STORAGE_KEY = "career-ops:config";

export function ConfigForm() {
  const [tab, setTab] = useState<Tab>("engine");
  const [mode, setMode] = useState<Mode>("cli");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [logos, setLogos] = useState(true);
  const [saved, setSaved] = useState(false);

  // Load saved prefs
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        // key/manual are not wired yet (nothing reads them) → never restore into
        // those dead panels; only the Installed-CLI path is functional.
        if (v.mode === "cli") setMode("cli");
        if (v.cliId) setCliId(v.cliId);
        if (v.provider) setProvider(v.provider);
        if (typeof v.logos === "boolean") setLogos(v.logos);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Detect installed CLIs
  useEffect(() => {
    fetch("/api/clis")
      .then((r) => r.json())
      .then((d) => {
        const list: Cli[] = d.clis ?? [];
        setClis(list);
        // auto-select first installed if nothing chosen yet
        setCliId((prev) => prev || list.find((c) => c.installed)?.id || "");
      })
      .catch(() => setClis([]));
  }, []);

  function save() {
    // The API key is deliberately NOT persisted: nothing reads it yet (the
    // key/manual panel is unwired) and a secret must never sit in clear-text
    // localStorage. Keys belong in the user's own CLI/provider config. The
    // Integrations tab's Gemini key + Google IDs are ALSO never written here —
    // they persist server-side via /api/settings.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, cliId, provider, logos }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const installed = clis?.filter((c) => c.installed) ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Config</h1>
      <p className="mt-1 text-sm text-muted">
        Run career-ops on your own AI, right on your computer. Your CV and data never leave your machine.
      </p>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-border" role="tablist">
        <TabButton active={tab === "engine"} onClick={() => setTab("engine")}>
          AI Engine
        </TabButton>
        <TabButton active={tab === "integrations"} onClick={() => setTab("integrations")}>
          Integrations
        </TabButton>
      </div>

      {tab === "engine" && (
        <div>
          {/* Engine mode */}
          <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            AI Engine
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <ModeCard
              active={mode === "cli"}
              onClick={() => setMode("cli")}
              icon={Terminal}
              title="Use an AI tool you have"
              hint="Recommended"
            />
            <ModeCard
              active={mode === "key"}
              onClick={() => setMode("key")}
              icon={KeyRound}
              title="Paste an AI key"
              hint="Coming soon"
              disabled
            />
            <ModeCard
              active={mode === "manual"}
              onClick={() => setMode("manual")}
              icon={TerminalSquare}
              title="No setup needed"
              hint="Coming soon"
              disabled
            />
          </div>

          <div className="mt-6">
            {mode === "cli" && (
              <div>
                <p className="mb-1 text-sm text-muted">
                  career-ops uses an AI tool you already have — signed in, your own usage, nothing to paste.
                </p>
                <p className="mb-3 text-xs text-faint">Works with Claude Code, Codex, OpenCode and more — free ones work great.</p>
                {clis === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="size-4 animate-spin" /> Checking what&apos;s on your computer…
                  </div>
                ) : installed.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                    No AI tool yet? Free options like <span className="text-foreground">OpenCode</span> with Qwen or GLM work great.{" "}
                    <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                      Get one free <ExternalLink className="size-3" />
                    </a>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {clis.map((c) => {
                      const selected = c.id === cliId;
                      return (
                        <div
                          key={c.id}
                          className={cn(
                            "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors",
                            selected
                              ? "border-brand/50 bg-brand-soft"
                              : c.installed
                                ? "border-border bg-surface/50"
                                : "border-border/60 bg-surface/20",
                          )}
                        >
                          {c.installed ? (
                            <Check className="size-4 shrink-0 text-emerald-400" />
                          ) : (
                            <CircleDashed className="size-4 shrink-0 text-faint" />
                          )}
                          <button
                            type="button"
                            disabled={!c.installed}
                            onClick={() => setCliId(c.id)}
                            className={cn(
                              "flex flex-1 items-center gap-2 text-left max-sm:min-h-[44px]",
                              c.installed ? "" : "cursor-default",
                            )}
                          >
                            <span
                              className={cn(
                                "font-medium",
                                selected ? "text-foreground" : c.installed ? "" : "text-muted",
                              )}
                            >
                              {c.name}
                            </span>
                            <span className="font-mono text-xs text-faint">{c.run}</span>
                          </button>
                          {c.installed ? (
                            <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-faint sm:block">
                              {c.path}
                            </span>
                          ) : (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex shrink-0 items-center justify-center gap-1 text-xs text-brand hover:underline max-sm:min-h-[44px]"
                            >
                              Install <ExternalLink className="size-3" />
                            </a>
                          )}
                        </div>
                      );
                    })}
                    {installed.length === 0 && (
                      <p className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-xs text-muted">
                        No supported CLI found on your PATH. Install one (e.g. Claude Code, Gemini CLI, OpenCode) to get started.
                      </p>
                    )}
                    <p className="mt-2 text-[11px] leading-relaxed text-faint">
                      Best on <span className="text-muted">Claude Code</span> (live progress, the agentic apply + AI search,
                      reliable evaluation persistence). Other CLIs work for the core flows with reduced features.
                    </p>
                  </div>
                )}
              </div>
            )}

            {mode === "key" && (
              <div className="space-y-5">
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    Provider
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setProvider(p.id)}
                        className={cn(
                          "rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
                          provider === p.id
                            ? "border-brand/50 bg-brand-soft text-foreground"
                            : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    Paste an AI key
                  </label>
                  <p className="mb-2 text-xs text-faint">Bring a key from OpenAI, Anthropic, and others.</p>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                    className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                  />
                  <p className="mt-2 text-xs text-faint">
                    Stored only in this browser — never sent anywhere but your chosen provider.
                  </p>
                </div>
              </div>
            )}

            {mode === "manual" && (
              <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                The easiest way in — no keys, nothing to set up. On the roadmap.
              </div>
            )}
          </div>

          {/* Appearance / privacy */}
          <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Appearance
          </label>
          <button
            type="button"
            onClick={() => setLogos((v) => !v)}
            className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Company logos</span>
              <span className="mt-0.5 block text-xs text-faint">
                Show each company&apos;s real logo. Fetched once through your local server and cached on
                disk — only the employer domain is sent to a third party. Off = colored monograms only.
              </span>
            </span>
            <span
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                logos ? "bg-brand" : "bg-surface-hover",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
                  logos ? "translate-x-[1.375rem]" : "translate-x-0.5",
                )}
              />
            </span>
          </button>

          <div className="mt-8 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
            >
              {saved ? <Check className="size-4" /> : null}
              {saved ? "Saved" : "Save config"}
            </button>
            <span className="text-xs text-faint">Local-first · on our roadmap</span>
          </div>
        </div>
      )}

      {tab === "integrations" && <IntegrationsTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors max-sm:min-h-[44px]",
        active
          ? "border-brand font-medium text-foreground"
          : "border-transparent text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : active
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active && !disabled ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-faint">{hint}</span>
    </button>
  );
}

// ── Integrations tab ─────────────────────────────────────────────────────────

type FieldStatus = { set: boolean; source: string; masked: string | null };
type SettingsFields = Record<string, FieldStatus>;
type ResultTone = "ok" | "bad" | "load";
type ActionState = { verifying?: boolean; saving?: boolean; result?: { tone: ResultTone; text: string } };

const AI_STUDIO_URL = "https://aistudio.google.com/apikey";

function IntegrationsTab() {
  const [fields, setFields] = useState<SettingsFields | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Gemini key: NEVER pre-filled with the real value; only a masked hint from GET.
  const [keyInput, setKeyInput] = useState("");
  const [rotating, setRotating] = useState(false);

  // Google identifiers — safe to show/pre-fill (they are not secrets).
  const [sheet, setSheet] = useState("");
  const [drive, setDrive] = useState("");
  const [bucket, setBucket] = useState("");

  // Per-field verify/save UI state.
  const [action, setAction] = useState<Record<string, ActionState>>({});

  function applyFields(f: SettingsFields) {
    setFields(f);
    // Pre-fill the plain identifiers (never the masked secret key).
    setSheet(f.googleSpreadsheetId?.set ? (f.googleSpreadsheetId.masked ?? "") : "");
    setDrive(f.googleDriveFolderId?.set ? (f.googleDriveFolderId.masked ?? "") : "");
    setBucket(f.googleStorageBucket?.set ? (f.googleStorageBucket.masked ?? "") : "");
  }

  async function refresh() {
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) throw new Error(`GET /api/settings failed (${r.status})`);
      const d = await r.json();
      applyFields((d.fields ?? {}) as SettingsFields);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load settings");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setResult(name: string, tone: ResultTone, text: string) {
    setAction((a) => ({ ...a, [name]: { ...a[name], result: { tone, text } } }));
  }

  async function doVerify(name: string, payload: Record<string, string>) {
    setAction((a) => ({ ...a, [name]: { ...a[name], verifying: true, result: undefined } }));
    try {
      const r = await fetch("/api/settings/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok || d.available === false) {
        setResult(name, "bad", d.error ?? "Verification unavailable");
        return;
      }
      const res = d.results?.[name];
      if (res?.ok) setResult(name, "ok", name === "geminiApiKey" ? "Key valid — Gemini reachable" : "Access confirmed");
      else setResult(name, "bad", res?.error ?? "Verification failed");
    } catch {
      setResult(name, "bad", "Network error while verifying");
    } finally {
      setAction((a) => ({ ...a, [name]: { ...a[name], verifying: false } }));
    }
  }

  async function doSave(name: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setResult(name, "bad", "Enter a value first");
      return;
    }
    setAction((a) => ({ ...a, [name]: { ...a[name], saving: true, result: undefined } }));
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [name]: trimmed }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        applyFields((d.fields ?? {}) as SettingsFields);
        if (name === "geminiApiKey") {
          setKeyInput("");
          setRotating(false);
        }
        setResult(name, "ok", "Saved — changes live");
        return;
      }
      // Surface per-target verify errors returned by POST when it verifies before save.
      const perTarget = d.results?.[name]?.error as string | undefined;
      setResult(name, "bad", perTarget ?? d.error ?? "Couldn’t save");
    } catch {
      setResult(name, "bad", "Network error while saving");
    } finally {
      setAction((a) => ({ ...a, [name]: { ...a[name], saving: false } }));
    }
  }

  if (loadError) {
    return (
      <div className="mt-8">
        <ResultLine tone="bad" text={loadError} />
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <RotateCw className="size-3.5" /> Retry
        </button>
      </div>
    );
  }

  if (!fields) {
    return (
      <div className="mt-10 flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" /> Loading integrations…
      </div>
    );
  }

  const keySet = fields.geminiApiKey?.set ?? false;
  const showKeyInput = !keySet || rotating;

  return (
    <div>
      {/* Gemini */}
      <label className="mt-7 mb-2.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
        Gemini
      </label>
      <div className="rounded-[14px] border border-border bg-surface/55 px-[18px]">
        <div className="border-b border-border py-[18px] last:border-b-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="size-[15px] text-brand" /> Gemini API key
            </span>
            <StatusBadge set={keySet} setLabel="Key set" />
          </div>
          <p className="my-2 max-w-[60ch] text-[12.5px] leading-relaxed text-faint">
            Powers job scoring, report generation and the assistant. Create one in{" "}
            <a href={AI_STUDIO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-text hover:underline">
              Google AI Studio <ExternalLink className="size-3" />
            </a>
            .
          </p>

          {showKeyInput ? (
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="AIza…"
              autoComplete="off"
              aria-label="Gemini API key"
              className="w-full rounded-[10px] border border-border bg-surface/65 px-3.5 py-2.5 font-mono text-[13px] outline-none transition-colors placeholder:text-faint focus:border-brand/50"
            />
          ) : (
            <input
              type="text"
              value={fields.geminiApiKey?.masked ?? "AIza…"}
              disabled
              aria-label="Gemini API key (masked)"
              className="w-full rounded-[10px] border border-border bg-surface/65 px-3.5 py-2.5 font-mono text-[13px] text-muted outline-none"
            />
          )}

          <div className="mt-2.5 flex flex-wrap gap-2">
            {showKeyInput ? (
              <>
                <GhostButton
                  onClick={() => void doVerify("geminiApiKey", { geminiApiKey: keyInput })}
                  disabled={!keyInput.trim() || action.geminiApiKey?.verifying}
                >
                  {action.geminiApiKey?.verifying ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                  Test key
                </GhostButton>
                <BrandButton
                  onClick={() => void doSave("geminiApiKey", keyInput)}
                  disabled={!keyInput.trim() || action.geminiApiKey?.saving}
                >
                  {action.geminiApiKey?.saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {action.geminiApiKey?.saving ? "Saving…" : "Save"}
                </BrandButton>
                {keySet && rotating ? (
                  <GhostButton
                    onClick={() => {
                      setRotating(false);
                      setKeyInput("");
                      setAction((a) => ({ ...a, geminiApiKey: {} }));
                    }}
                  >
                    Cancel
                  </GhostButton>
                ) : null}
              </>
            ) : (
              <GhostButton onClick={() => setRotating(true)}>
                <RotateCw className="size-3.5" /> Rotate
              </GhostButton>
            )}
          </div>

          {action.geminiApiKey?.result ? (
            <ResultLine tone={action.geminiApiKey.result.tone} text={action.geminiApiKey.result.text} />
          ) : null}
          <p className="mt-3 text-[11.5px] text-faint">
            Stored on the server — only a masked hint is shown, never the full key.
          </p>
        </div>
      </div>

      {/* Google integrations */}
      <label className="mt-7 mb-2.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
        Google integrations
      </label>
      <div className="rounded-[14px] border border-border bg-surface/55 px-[18px]">
        <IdField
          icon={Table}
          title="Google Sheet ID"
          helper="Mirrors your pipeline tracker to a Google Sheet you can open anywhere."
          placeholder="1aB2c… (from the sheet URL)"
          value={sheet}
          onChange={setSheet}
          set={fields.googleSpreadsheetId?.set ?? false}
          state={action.googleSpreadsheetId}
          onVerify={() => void doVerify("googleSpreadsheetId", { googleSpreadsheetId: sheet })}
          onSave={() => void doSave("googleSpreadsheetId", sheet)}
        />
        <IdField
          icon={Folder}
          title="Google Drive folder ID"
          helper="Uploads each generated report and tailored CV to this Drive folder."
          placeholder="0AeXq… (from the folder URL)"
          value={drive}
          onChange={setDrive}
          set={fields.googleDriveFolderId?.set ?? false}
          state={action.googleDriveFolderId}
          onVerify={() => void doVerify("googleDriveFolderId", { googleDriveFolderId: drive })}
          onSave={() => void doSave("googleDriveFolderId", drive)}
        />
        <IdField
          icon={Database}
          title="GCS bucket"
          helper="Optional — stores report/CV objects in Cloud Storage for public links."
          placeholder="my-bucket-name"
          value={bucket}
          onChange={setBucket}
          set={fields.googleStorageBucket?.set ?? false}
          optional
          state={action.googleStorageBucket}
          onVerify={() => void doVerify("googleStorageBucket", { googleStorageBucket: bucket })}
          onSave={() => void doSave("googleStorageBucket", bucket)}
        />
      </div>

      {/* GCP-first note */}
      <div className="mt-6 flex gap-3 rounded-[14px] border border-dashed border-border bg-brand-soft p-[18px]">
        <Lightbulb className="size-[18px] shrink-0 text-brand" />
        <div>
          <p className="text-[13.5px] font-semibold text-foreground">Running in the cloud?</p>
          <p className="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
            On Cloud Run these values can also come from <strong className="text-foreground">Secret Manager</strong>.
            Anything you enter here is written to the Cloud Run durable volume, so it survives restarts. Adding a{" "}
            <strong className="text-foreground">GCS bucket</strong> gives every report and CV a shareable public link.
          </p>
        </div>
      </div>
    </div>
  );
}

function IdField({
  icon: Icon,
  title,
  helper,
  placeholder,
  value,
  onChange,
  set,
  optional,
  state,
  onVerify,
  onSave,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  helper: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  set: boolean;
  optional?: boolean;
  state?: ActionState;
  onVerify: () => void;
  onSave: () => void;
}) {
  return (
    <div className="border-b border-border py-[18px] last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Icon className="size-[15px] text-brand" /> {title}
        </span>
        <StatusBadge set={set} setLabel="Set" optional={optional} />
      </div>
      <p className="my-2 max-w-[60ch] text-[12.5px] leading-relaxed text-faint">{helper}</p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={title}
        className="w-full rounded-[10px] border border-border bg-surface/65 px-3.5 py-2.5 font-mono text-[13px] outline-none transition-colors placeholder:text-faint focus:border-brand/50"
      />
      <div className="mt-2.5 flex flex-wrap gap-2">
        <GhostButton onClick={onVerify} disabled={!value.trim() || state?.verifying}>
          {state?.verifying ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          Verify access
        </GhostButton>
        <BrandButton onClick={onSave} disabled={!value.trim() || state?.saving}>
          {state?.saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {state?.saving ? "Saving…" : "Save"}
        </BrandButton>
      </div>
      {state?.result ? <ResultLine tone={state.result.tone} text={state.result.text} /> : null}
    </div>
  );
}

function StatusBadge({ set, setLabel, optional }: { set: boolean; setLabel: string; optional?: boolean }) {
  if (set) {
    return (
      <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
        <Check className="size-3" /> {setLabel}
      </span>
    );
  }
  return (
    <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-faint">
      {optional ? "Optional · not set" : "Not set"}
    </span>
  );
}

function ResultLine({ tone, text }: { tone: ResultTone; text: string }) {
  return (
    <div
      className={cn(
        "mt-3 inline-flex items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 text-[12.5px] font-medium",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : tone === "bad"
            ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
            : "border-border bg-surface-hover text-muted",
      )}
    >
      {tone === "ok" ? <Check className="size-3.5" /> : tone === "bad" ? <TriangleAlert className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
      <span>{text}</span>
    </div>
  );
}

function GhostButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full border border-border bg-surface/60 px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function BrandButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full border border-transparent bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-default disabled:opacity-75"
    >
      {children}
    </button>
  );
}
