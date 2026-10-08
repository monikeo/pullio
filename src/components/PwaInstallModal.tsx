import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '../store/useAppStore';
import { Zap, Share2, PlusSquare, CheckCircle2, X, Shield, WifiOff } from 'lucide-react';

interface PwaInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PwaInstallModal({ isOpen, onClose }: PwaInstallModalProps) {
  const { pwaInstallPrompt, triggerInstall, isPwaInstalled } = useAppStore();

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  const handleInstallClick = async () => {
    if (pwaInstallPrompt) {
      const ok = await triggerInstall();
      if (ok) onClose();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-md cursor-pointer"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwa-install-title"
            className="relative glass-panel w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-6 sm:p-7 bg-neutral-950 border border-white/10 shadow-2xl z-10"
          >
            {/* Top Glow Accent */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent blur-sm rounded-full" />

            <div className="flex justify-between items-start mb-5">
              <div className="flex items-center gap-3">
                <img src="/favicon.svg" alt="" className="size-10 rounded-[10px] shadow-lg shrink-0" width="40" height="40" />
                <div>
                  <h3 id="pwa-install-title" className="text-lg font-bold text-white leading-snug">
                    Install Pullio
                  </h3>
                  <p className="text-[11px] text-gray-400 font-medium">
                    Native Web Experience (PWA)
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="size-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Close modal"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Feature Perks */}
            <div className="grid grid-cols-2 gap-2.5 mb-6">
              <div className="p-2.5 bg-white/5 border border-white/5 rounded-[8px] flex items-center gap-2">
                <Zap className="size-4 text-[var(--accent)] shrink-0" />
                <span className="text-[11px] font-medium text-gray-300">Instant Load Speed</span>
              </div>
              <div className="p-2.5 bg-white/5 border border-white/5 rounded-[8px] flex items-center gap-2">
                <WifiOff className="size-4 text-emerald-400 shrink-0" />
                <span className="text-[11px] font-medium text-gray-300">Offline Shell Ready</span>
              </div>
              <div className="p-2.5 bg-white/5 border border-white/5 rounded-[8px] flex items-center gap-2">
                <Share2 className="size-4 text-indigo-400 shrink-0" />
                <span className="text-[11px] font-medium text-gray-300">Direct Share Target</span>
              </div>
              <div className="p-2.5 bg-white/5 border border-white/5 rounded-[8px] flex items-center gap-2">
                <Shield className="size-4 text-amber-400 shrink-0" />
                <span className="text-[11px] font-medium text-gray-300">Zero Browser Bars</span>
              </div>
            </div>

            {/* Platform-Specific Install Steps */}
            {isPwaInstalled ? (
              <div className="p-4 rounded-[10px] bg-green-500/10 border border-green-500/20 text-center flex flex-col gap-1">
                <CheckCircle2 className="size-6 text-green-400 mx-auto mb-1" />
                <h4 className="text-xs font-bold text-green-300 uppercase tracking-wider">Already Installed!</h4>
                <p className="text-[11px] text-gray-400">Pullio is running as an installed application on your device.</p>
              </div>
            ) : pwaInstallPrompt ? (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-gray-400 leading-relaxed">
                  Click below to install directly to your home screen or desktop application dock.
                </p>
                <button
                  onClick={handleInstallClick}
                  className="w-full py-3 bg-[var(--accent)] text-[var(--accent-text)] rounded-[8px] font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 btn-accent cursor-pointer shadow-lg min-h-[44px]"
                >
                  <Zap className="size-4 text-[var(--accent-text)]" /> Install to Device Now
                </button>
              </div>
            ) : isIOS ? (
              <div className="flex flex-col gap-3 bg-white/5 p-4 rounded-[10px] border border-white/5 text-xs text-gray-300">
                <h4 className="font-bold text-white text-xs uppercase tracking-wider mb-2">iOS Safari Instructions:</h4>
                <div className="flex items-start gap-2.5">
                  <span className="size-5 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-[var(--accent)] shrink-0">1</span>
                  <span>Tap the <strong className="text-white">Share</strong> button in Safari's navigation bar.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="size-5 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-[var(--accent)] shrink-0">2</span>
                  <span>Scroll down and tap <strong className="text-white">"Add to Home Screen"</strong>.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="size-5 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-[var(--accent)] shrink-0">3</span>
                  <span>Tap <strong className="text-white">Add</strong> in the top right corner.</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 bg-white/5 p-4 rounded-[10px] border border-white/5 text-xs text-gray-400">
                <h4 className="font-bold text-white text-xs uppercase tracking-wider mb-1">Desktop &amp; Android Browser:</h4>
                <p className="text-[11px] leading-relaxed">
                  Look for the <strong className="text-white">Install</strong> icon in your browser's address bar or open your browser settings and select <strong className="text-white">"Install Pullio"</strong>.
                </p>
              </div>
            )}

            <div className="mt-5 pt-3 border-t border-white/5 text-center">
              <button
                onClick={onClose}
                className="text-xs text-gray-400 hover:text-white transition-colors cursor-pointer font-medium"
              >
                Close Window
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
