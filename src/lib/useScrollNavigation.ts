import { useEffect, useState } from 'react';

// Direction changes need deliberate movement, so touch jitter and elastic
// overscroll do not repeatedly toggle the app chrome.
export function useScrollNavigation(resetKey: string) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
    const compact = window.matchMedia('(max-width: 1023px)');
    let previous = Math.max(0, window.scrollY);
    let distance = 0;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const current = Math.min(max, Math.max(0, window.scrollY));
      const delta = current - previous;
      previous = current;
      if (!compact.matches || document.body.style.overflow === 'hidden') return;
      const focused = document.activeElement;
      const editing = focused?.matches('input, textarea, select, [contenteditable="true"]') && focused.getBoundingClientRect().bottom > 0;
      if (current < 100 || current >= max - 8 || editing) {
        distance = 0; setHidden(false); return;
      }
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      if (Math.abs(distance) >= 18) { setHidden(distance > 0); distance = 0; }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const onResize = () => { previous = Math.max(0, window.scrollY); distance = 0; setHidden(false); };
    const onFocus = () => { distance = 0; setHidden(false); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('focusin', onFocus);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocus);
    };
  }, [resetKey]);
  return hidden;
}
