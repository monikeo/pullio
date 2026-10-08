import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, Smartphone, CheckCircle2, Trash2, Heart, ExternalLink, Zap, 
  HelpCircle, ShieldCheck, KeyRound, Upload, Check, AlertCircle, Loader2,
  ChevronDown, ChevronUp, FileText, Globe, RefreshCw
} from 'lucide-react';
import PwaInstallModal from './PwaInstallModal';

interface CookieStatus {
  configured: boolean;
  size: number;
  domains: string[];
  updatedAt: number | null;
}

type QueueLimit = 1 | 2 | 3 | 4;

export default function SettingsPanel() {
  const { preferences, updatePreferences, clearHistory, resetPreferences, pwaInstallPrompt, triggerInstall, isPwaInstalled } = useAppStore();
  const [clearedMessage, setClearedMessage] = useState(false);
  const [isPwaModalOpen, setIsPwaModalOpen] = useState(false);
  const [isSavingQueueLimit, setIsSavingQueueLimit] = useState(false);
  const [queueLimitMessage, setQueueLimitMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [filenameTemplateInput, setFilenameTemplateInput] = useState(preferences.filenameTemplate);
  const [filenameTemplateMessage, setFilenameTemplateMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  useEffect(() => {
    setFilenameTemplateInput(preferences.filenameTemplate);
  }, [preferences.filenameTemplate]);

  // Cookie manager state
  const [cookieStatus, setCookieStatus] = useState<CookieStatus>({
    configured: false,
    size: 0,
    domains: [],
    updatedAt: null,
  });
  const [cookieInput, setCookieInput] = useState('');
  const [cookieDomain, setCookieDomain] = useState('.bilibili.com');
  const [isSavingCookie, setIsSavingCookie] = useState(false);
  const [isClearingCookie, setIsClearingCookie] = useState(false);
  const [cookieMsg, setCookieMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cookieMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCookieMessage = (message: { text: string; isError?: boolean }, duration = 4000) => {
    if (cookieMessageTimerRef.current) clearTimeout(cookieMessageTimerRef.current);
    setCookieMsg(message);
    if (!message.isError) {
      cookieMessageTimerRef.current = setTimeout(() => setCookieMsg(null), duration);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    fetch('/api/cookies', { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || 'Could not load cookie status.');
        if (!data || typeof data.configured !== 'boolean' || !Array.isArray(data.domains)) {
          throw new Error('The server returned an invalid cookie status.');
        }
        setCookieStatus({
          configured: data.configured,
          size: Number.isFinite(data.size) ? data.size : 0,
          domains: data.domains.filter((domain: unknown): domain is string => typeof domain === 'string'),
          updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        showCookieMessage({
          text: error instanceof Error ? error.message : 'Could not load cookie status.',
          isError: true,
        });
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      controller.abort();
      clearTimeout(timeout);
      if (cookieMessageTimerRef.current) clearTimeout(cookieMessageTimerRef.current);
      if (clearedMessageTimerRef.current) clearTimeout(clearedMessageTimerRef.current);
    };
  }, []);

  const handleClearCache = () => {
    clearHistory();
    resetPreferences();
    setClearedMessage(true);
    if (clearedMessageTimerRef.current) clearTimeout(clearedMessageTimerRef.current);
    clearedMessageTimerRef.current = setTimeout(() => setClearedMessage(false), 2500);
  };

  const handleQueueLimitChange = async (limit: QueueLimit) => {
    setIsSavingQueueLimit(true);
    setQueueLimitMessage(null);
    try {
      const response = await fetch('/api/queue/config', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentDownloads: limit }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Could not update the download queue limit.');
      if (data?.maxConcurrentDownloads !== limit) throw new Error('The server did not confirm the selected queue limit.');
      updatePreferences({ maxConcurrentDownloads: limit });
      setQueueLimitMessage({ text: `Queue limit set to ${limit} simultaneous download${limit === 1 ? '' : 's'}.` });
    } catch (error) {
      setQueueLimitMessage({
        text: error instanceof Error ? error.message : 'Could not update the download queue limit.',
        isError: true,
      });
    } finally {
      setIsSavingQueueLimit(false);
    }
  };

  const handleSaveFilenameTemplate = () => {
    const value = filenameTemplateInput.trim();
    const unknownToken = value.match(/\{([^{}]+)\}/g)?.find((token) => !['{title}', '{platform}', '{date}', '{quality}', '{ext}'].includes(token));
    if (!value || value.length > 120 || /[\\/:*?"<>|\u0000-\u001f]/.test(value) || unknownToken || /[{}]/.test(value.replace(/\{(?:title|platform|date|quality|ext)\}/g, ''))) {
      setFilenameTemplateMessage({ text: 'Use 1–120 characters, supported tokens, and no file path characters.', isError: true });
      return;
    }
    updatePreferences({ filenameTemplate: value });
    setFilenameTemplateInput(value);
    setFilenameTemplateMessage({ text: 'Filename template saved.' });
  };

  const handleInstallClick = () => {
    if (pwaInstallPrompt) {
      triggerInstall();
    } else {
      setIsPwaModalOpen(true);
    }
  };

  const handleSaveCookie = async () => {
    if (!cookieInput.trim()) return;
    setIsSavingCookie(true);
    setCookieMsg(null);
    try {
      // Clean Chinese fullwidth punctuation (；, ：, ＝, ，) before sending to server
      const cleaned = cookieInput
        .replace(/\uff1b/g, ';')
        .replace(/\uff1a/g, ':')
        .replace(/\uff1d/g, '=')
        .replace(/\uff0c/g, ',')
        .trim();

      const res = await fetch('/api/cookies', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: cleaned, domain: cookieDomain }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to save cookies');
      if (!data || typeof data.configured !== 'boolean') throw new Error('The server returned an invalid cookie status.');
      setCookieStatus(data);
      setCookieInput('');
      showCookieMessage({ text: 'Session cookies saved. Access still depends on the platform and your account permissions.' });
    } catch (err: unknown) {
      showCookieMessage({
        text: err instanceof Error && err.name === 'TimeoutError'
          ? 'Saving cookies timed out. Check the server connection and retry.'
          : err instanceof Error ? err.message : 'Failed to save cookies',
        isError: true,
      });
    } finally {
      setIsSavingCookie(false);
    }
  };

  const handleClearCookies = async () => {
    setIsClearingCookie(true);
    try {
      const res = await fetch('/api/cookies', {
        method: 'DELETE',
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to clear cookies');
      if (!data || typeof data.configured !== 'boolean') throw new Error('The server returned an invalid cookie status.');
      setCookieStatus(data);
      showCookieMessage({ text: 'Cookies cleared from server.' }, 3000);
    } catch (err: unknown) {
      showCookieMessage({
        text: err instanceof Error && err.name === 'TimeoutError'
          ? 'Clearing cookies timed out. Check the server connection and retry.'
          : err instanceof Error ? err.message : 'Failed to clear cookies',
        isError: true,
      });
    } finally {
      setIsClearingCookie(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result;
      if (typeof text === 'string' && text.trim()) setCookieInput(text);
      else showCookieMessage({ text: 'The selected file is empty or could not be read.', isError: true });
    };
    reader.onerror = () => showCookieMessage({ text: 'Could not read the selected cookies file.', isError: true });
    reader.onabort = () => showCookieMessage({ text: 'Reading the selected cookies file was cancelled.', isError: true });
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -15 }}
        className="glass-panel p-6 sm:p-8 w-full max-w-4xl mx-auto mt-6 flex flex-col gap-6 sm:gap-8"
      >
        <div className="flex items-center gap-2 pb-4 border-b border-white/10">
          <Settings className="size-5 text-[var(--accent)]" />
          <h2 className="text-base font-bold text-white tracking-wide">Application Preferences</h2>
        </div>

        {/* PWA / App Installation Card */}
        <div className="p-5 rounded-[12px] bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent border border-indigo-500/20 relative overflow-hidden">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="size-10 rounded-[10px] bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                <Smartphone className="size-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-white flex items-center gap-2">
                  Install as Progressive Web App (PWA)
                  {isPwaInstalled && (
                    <span className="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full font-bold">
                      Installed
                    </span>
                  )}
                </h3>
                <p className="text-xs text-gray-400 mt-1 max-w-md leading-relaxed">
                  Install Pullio on your phone, tablet, or desktop for offline access, instant loading, and system Share menu integration.
                </p>
              </div>
            </div>

            {isPwaInstalled ? (
              <div className="flex items-center gap-1.5 text-xs text-green-400 font-bold shrink-0">
                <CheckCircle2 className="size-4" /> Ready on Device
              </div>
            ) : (
              <button
                onClick={handleInstallClick}
                className="px-4 py-2.5 rounded-[8px] bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg shrink-0 flex items-center gap-2 min-h-[40px]"
              >
                <Zap className="size-3.5" /> {pwaInstallPrompt ? 'Install App' : 'How to Install'}
              </button>
            )}
          </div>
        </div>

        {/* ─── PLATFORM AUTHENTICATION & COOKIE MANAGER ─────────────────────── */}
        <div className="p-5 rounded-[12px] bg-white/5 border border-white/10 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="size-9 rounded-[8px] bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)] shrink-0">
                <KeyRound className="size-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">Platform Authentication (Cookies)</h3>
                  {cookieStatus.configured ? (
                    <span className="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                      <Check className="size-2.5" /> Active
                    </span>
                  ) : (
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">
                      Not Configured
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Use your own browser session for content your account can access. Cookies do not bypass CAPTCHA, rate limits, or platform security checks.
                </p>
              </div>
            </div>

            {cookieStatus.configured && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleClearCookies}
                  disabled={isClearingCookie}
                  className="px-3 py-1.5 rounded-[8px] bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >
                  {isClearingCookie ? 'Clearing…' : 'Clear Cookies'}
                </button>
              </div>
            )}
          </div>

          {cookieStatus.configured && cookieStatus.domains.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 p-2.5 rounded-[8px] bg-black/40 border border-white/5 text-[11px] font-mono text-gray-300">
              <span className="text-gray-500 font-sans font-bold">Active Domains:</span>
              {cookieStatus.domains.map((dom) => (
                <span key={dom} className="px-2 py-0.5 rounded bg-white/10 text-white font-bold">
                  {dom}
                </span>
              ))}
              <span className="text-gray-500 ml-auto">
                File: {Math.round(cookieStatus.size / 1024 * 10) / 10} KB
              </span>
            </div>
          )}

          {/* Cookie Input Area */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <label className="font-bold text-gray-300 flex items-center gap-1.5">
                <FileText className="size-3.5 text-[var(--accent)]" />
                Add a platform session cookie or cookies.txt content:
              </label>

              <button
                onClick={() => setShowInstructions(!showInstructions)}
                className="text-[11px] text-[var(--accent)] hover:underline flex items-center gap-1 cursor-pointer"
              >
                <HelpCircle className="size-3" />
                {showInstructions ? 'Hide Instructions' : 'How to export browser cookies'}
              </button>
            </div>

            {/* Quick Helper Accordion */}
            <AnimatePresence>
              {showInstructions && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="p-3.5 rounded-[8px] bg-indigo-950/30 border border-indigo-500/20 text-xs text-indigo-200 flex flex-col gap-2 overflow-hidden"
                >
                  <p className="font-bold text-white flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5 text-indigo-400" />
                    Export a session only from an account you own or are authorized to use:
                  </p>
                  <ol className="list-decimal list-inside flex flex-col gap-1 text-[11px] text-gray-300 pl-1 leading-relaxed">
                    <li>Sign in to the platform in your browser and confirm the content is available to your account.</li>
                    <li>Use a reputable browser export tool to save the platform’s cookies in Netscape <code>.txt</code> format.</li>
                    <li>Select the matching target domain below, then upload the exported file or paste its contents.</li>
                    <li>Treat exported cookies like passwords. A platform challenge or restricted video may still be unavailable.</li>
                  </ol>
                </motion.div>
              )}
            </AnimatePresence>

            <textarea
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              placeholder="Paste platform cookie data or Netscape cookies.txt content here..."
              rows={3}
              className="w-full bg-black/60 border border-white/10 rounded-[8px] p-3 text-xs font-mono text-gray-200 placeholder:text-gray-600 outline-none focus:border-[var(--accent)] resize-y"
            />

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-400 font-bold">Target Domain:</span>
                <select
                  value={cookieDomain}
                  onChange={(e) => setCookieDomain(e.target.value)}
                  className="bg-black/60 border border-white/10 rounded-[6px] px-2 py-1 text-xs text-gray-200 outline-none focus:border-[var(--accent)]"
                >
                  <option value=".bilibili.com">.bilibili.com (Bilibili)</option>
                  <option value=".douyin.com">.douyin.com (Douyin 抖音)</option>
                  <option value=".xiaohongshu.com">.xiaohongshu.com (XiaoHongShu 小红书)</option>
                  <option value=".youtube.com">.youtube.com (YouTube)</option>
                  <option value=".instagram.com">.instagram.com (Instagram)</option>
                </select>

                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept=".txt"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-[6px] bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1"
                  title="Upload cookies.txt file"
                >
                  <Upload className="size-3" /> Upload .txt
                </button>
              </div>

              <button
                onClick={handleSaveCookie}
                disabled={isSavingCookie || !cookieInput.trim()}
                className="px-4 py-2 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider transition-all btn-accent cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5 shadow min-h-[36px]"
              >
                {isSavingCookie ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-3.5" />
                    Save Cookies
                  </>
                )}
              </button>
            </div>

            {cookieMsg && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-2.5 rounded-[8px] text-xs font-medium flex items-center gap-2 ${
                  cookieMsg.isError 
                    ? 'bg-red-950/40 border border-red-500/30 text-red-300' 
                    : 'bg-green-950/40 border border-green-500/30 text-green-300'
                }`}
              >
                {cookieMsg.isError ? (
                  <AlertCircle className="size-3.5 text-red-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="size-3.5 text-green-400 shrink-0" />
                )}
                <span>{cookieMsg.text}</span>
              </motion.div>
            )}
          </div>
        </div>

        {/* Download Configuration */}
        <div className="flex flex-col gap-4 sm:gap-5">
          <h3 className="text-xs font-bold uppercase tracking-widest text-neutral-400">
            Engine Presets
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="p-4 rounded-[10px] bg-white/5 border border-white/5 flex flex-col gap-2 sm:col-span-2 lg:col-span-3">
              <label htmlFor="filename-template" className="text-xs font-bold text-white block">Custom Filename Template</label>
              <p className="text-[11px] text-gray-400">Choose how completed downloads are named in your browser.</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="filename-template"
                  value={filenameTemplateInput}
                  onChange={(event) => { setFilenameTemplateInput(event.target.value); setFilenameTemplateMessage(null); }}
                  maxLength={120}
                  aria-describedby="filename-template-help filename-template-preview"
                  placeholder="{title} - {platform}"
                  className="min-w-0 flex-1 bg-black/60 border border-white/10 rounded-[8px] px-3 py-2 text-xs text-neutral-100 outline-none focus:border-[var(--accent)]"
                />
                <button type="button" onClick={handleSaveFilenameTemplate} className="px-4 py-2 bg-[var(--accent)] text-black rounded-[8px] text-xs font-bold hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">Save template</button>
              </div>
              <p id="filename-template-help" className="text-[10px] text-gray-500">Tokens: {'{title}'} · {'{platform}'} · {'{date}'} · {'{quality}'} · {'{ext}'}. Example: {'{title}'} - {'{platform}'} - {'{quality}'}</p>
              <p id="filename-template-preview" className="text-[10px] text-neutral-400">Preview: <span className="text-neutral-200">{(() => {
                const preview = filenameTemplateInput.replaceAll('{title}', 'Summer clip').replaceAll('{platform}', 'youtube').replaceAll('{date}', new Date().toISOString().slice(0, 10)).replaceAll('{quality}', '1080p').replaceAll('{ext}', 'mp4') || 'Summer clip - youtube';
                return filenameTemplateInput.includes('{ext}') ? preview : `${preview}.mp4`;
              })()}</span></p>
              {filenameTemplateMessage && <p className={`text-[10px] ${filenameTemplateMessage.isError ? 'text-red-300' : 'text-emerald-300'}`} role={filenameTemplateMessage.isError ? 'alert' : 'status'}>{filenameTemplateMessage.text}</p>}
            </div>
            {/* Default Format */}
            <div className="p-4 rounded-[10px] bg-white/5 border border-white/5 flex flex-col gap-2">
              <label className="text-xs font-bold text-white block">Default Video Quality Preset</label>
              <p className="text-[11px] text-gray-400">Automatically select this resolution when available</p>
              <select
                value={preferences.defaultFormat}
                onChange={(e) => updatePreferences({ defaultFormat: e.target.value as any })}
                className="w-full mt-2 bg-black/60 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)]"
              >
                <option value="best">Best Available (Source Max)</option>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p HD</option>
                <option value="audio-320">MP3 · 320 kbps target</option>
                <option value="audio-128">MP3 · 128 kbps target</option>
              </select>
            </div>

            {/* Default Container */}
            <div className="p-4 rounded-[10px] bg-white/5 border border-white/5 flex flex-col gap-2">
              <label className="text-xs font-bold text-white block">Target Media Container</label>
              <p className="text-[11px] text-gray-400">Preferred output file container</p>
              <select
                value={preferences.defaultContainer}
                onChange={(e) => updatePreferences({ defaultContainer: e.target.value as any })}
                className="w-full mt-2 bg-black/60 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)]"
              >
                <option value="mp4">MP4 (Universal Compatibility)</option>
                <option value="mkv">MKV (Multi-Track Container)</option>
                <option value="webm">WebM (Open Web Video)</option>
                <option value="mp3">MP3 (Audio Only)</option>
              </select>
            </div>

            {/* Server Queue Limit */}
            <div className="p-4 rounded-[10px] bg-white/5 border border-white/5 flex flex-col gap-2">
              <label htmlFor="max-concurrent-downloads" className="text-xs font-bold text-white block">Maximum Concurrent Downloads</label>
              <p className="text-[11px] text-gray-400">Limit how many jobs run at once. Applies to this server and its open sessions.</p>
              <select
                id="max-concurrent-downloads"
                value={preferences.maxConcurrentDownloads}
                disabled={isSavingQueueLimit}
                onChange={(event) => void handleQueueLimitChange(Number(event.target.value) as QueueLimit)}
                className="w-full mt-2 bg-black/60 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] disabled:opacity-60"
              >
                <option value={1}>1 download · lowest resource use</option>
                <option value={2}>2 downloads · balanced</option>
                <option value={3}>3 downloads</option>
                <option value={4}>4 downloads · fastest queue</option>
              </select>
              <p className="text-[10px] text-gray-500">Lowering the limit does not interrupt transfers already running.</p>
              {queueLimitMessage && (
                <p className={`text-[10px] leading-relaxed ${queueLimitMessage.isError ? 'text-red-300' : 'text-emerald-300'}`} role={queueLimitMessage.isError ? 'alert' : 'status'}>
                  {queueLimitMessage.text}
                </p>
              )}
            </div>
          </div>

          {/* Toggles */}
          <div className="flex flex-col gap-3 pt-2">
            <label className="flex items-center justify-between p-3.5 bg-white/5 border border-white/5 rounded-[10px] cursor-pointer">
              <div>
                <span className="text-xs font-bold text-white block">Auto-Analyze on Paste</span>
                <span className="text-[11px] text-gray-400">Automatically start analyzing when clicking Paste button</span>
              </div>
              <input
                type="checkbox"
                checked={preferences.autoAnalyzeOnPaste}
                onChange={(e) => updatePreferences({ autoAnalyzeOnPaste: e.target.checked })}
                className="size-4 accent-[var(--accent)] rounded cursor-pointer"
              />
            </label>
          </div>
        </div>

        {/* Storage & Clear */}
        <div className="flex flex-col gap-3 pt-4 border-t border-white/10">
          <h3 className="text-xs font-bold uppercase tracking-widest text-neutral-400">
            Data &amp; Privacy
          </h3>
          <div className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-[10px]">
            <div>
              <h4 className="text-xs font-bold text-white">Clear Local Storage &amp; History</h4>
              <p className="text-[11px] text-gray-400 mt-0.5">Remove saved download history and cached preferences</p>
            </div>
            <button
              onClick={handleClearCache}
              className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-[8px] text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer min-h-[36px]"
            >
              <Trash2 className="size-3.5" />
              {clearedMessage ? 'Cleared!' : 'Clear Data'}
            </button>
          </div>
        </div>

        {/* Architecture Credits */}
        <div className="text-center pt-4 border-t border-white/5 flex flex-col gap-2">
          <p className="text-xs text-gray-500 flex items-center justify-center gap-1.5">
            Crafted with <Heart className="size-3.5 text-red-500 fill-current" /> by <strong className="text-white">KEO MONI</strong>
          </p>
          <p className="text-[10px] text-gray-600 font-mono">
            Powered by yt-dlp native engine, static FFmpeg 5.x &amp; Vite PWA
          </p>
        </div>
      </motion.div>

      <PwaInstallModal isOpen={isPwaModalOpen} onClose={() => setIsPwaModalOpen(false)} />
    </>
  );
}
