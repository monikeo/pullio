import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Github, Heart, Shield, Zap } from 'lucide-react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={onClose} 
            className="absolute inset-0 bg-black/80 backdrop-blur-md cursor-pointer"
          />

          {/* Modal Container */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }} 
            animate={{ opacity: 1, scale: 1, y: 0 }} 
            exit={{ opacity: 0, scale: 0.95, y: 20 }} 
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-pullio-title"
            className="relative glass-panel w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-6 sm:p-8 bg-neutral-900 border border-white/10 shadow-2xl"
          >
            {/* Top Glow Accent */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent blur-sm rounded-full"/>

            <div className="flex justify-between items-start mb-6">
              <div>
                <h3 id="about-pullio-title" className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                  About <span className="text-[var(--accent)]">Pullio</span>
                </h3>
                <p className="text-xs font-mono text-gray-500 uppercase mt-1 tracking-widest">
                  Universal Media Downloader &amp; Converter
                </p>
              </div>
              <button 
                onClick={onClose} 
                className="size-8 rounded-[8px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" 
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-6 text-sm text-gray-300 leading-relaxed">
              <p>
                <strong>Pullio</strong> extracts and converts media from supported platforms, with quality and format options powered by yt-dlp and FFmpeg.
              </p>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="p-3 rounded-[8px] bg-white/5 border border-white/5 flex gap-3 items-start">
                  <Zap className="size-5 text-[var(--accent)] mt-0.5 shrink-0"/>
                  <div>
                    <h4 className="font-semibold text-white text-xs uppercase tracking-wider">Fast Queues</h4>
                    <p className="text-xs text-gray-400 mt-1">Instant, multi-threaded pipelines</p>
                  </div>
                </div>
                <div className="p-3 rounded-[8px] bg-white/5 border border-white/5 flex gap-3 items-start">
                  <Shield className="size-5 text-[var(--accent)] mt-0.5 shrink-0"/>
                  <div>
                    <h4 className="font-semibold text-white text-xs uppercase tracking-wider">Stateless</h4>
                    <p className="text-xs text-gray-400 mt-1">Zero trackers or temporary databases</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/5 pt-6 flex flex-col items-center text-center">
                <div className="inline-flex items-center gap-1.5 py-1 px-3 bg-red-500/10 text-red-400 text-xs font-bold uppercase rounded-full mb-3 tracking-widest border border-red-500/20">
                  <Heart className="size-3.5 fill-current"/> Crafted By
                </div>
                
                <h4 className="text-lg font-bold text-white">KEO MONI</h4>
                <p className="text-gray-400 text-xs mt-1">Lead Architect &amp; Developer</p>

                <div className="flex gap-4 mt-4">
                  <a href="https://github.com/monikeo" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-[8px] text-xs font-bold uppercase tracking-wider transition-all border border-white/10 min-h-[36px]">
                    <Github className="size-4"/> GitHub
                  </a>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-white/5 text-center">
              <button onClick={onClose} className="w-full py-2.5 bg-[var(--accent)] hover:opacity-95 text-[var(--accent-text)] font-bold rounded-[8px] uppercase tracking-wider text-xs transition-opacity cursor-pointer min-h-[40px]">
                Close Info
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
