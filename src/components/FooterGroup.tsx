import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export default function FooterGroup({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <section className="min-w-0">
    <h2 className="text-[11px] uppercase font-bold tracking-[0.14em] text-neutral-400">
      <span className="hidden sm:block mb-3">{title}</span>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)} className="sm:hidden flex min-h-12 w-full items-center justify-between gap-3 text-left rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
        <span>{title}<span className="block text-[11px] text-neutral-500 normal-case tracking-normal font-normal mt-0.5">{detail}</span></span>
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
      </button>
    </h2>
    <div id={id} className={expanded ? 'pt-3 pb-2 sm:p-0' : 'hidden sm:block'}>{children}</div>
  </section>;
}
