import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  declare readonly props: Readonly<AppErrorBoundaryProps>;
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Pullio UI render failed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen bg-[#030303] text-neutral-100 flex items-center justify-center px-5 py-12">
          <section role="alert" className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8 text-center shadow-2xl">
            <img src="/favicon.svg" alt="" width="48" height="48" className="mx-auto mb-5 size-12 rounded-xl" />
            <h1 className="text-xl sm:text-2xl font-bold text-white">Pullio ran into a problem</h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              The page stopped unexpectedly. Reload Pullio to recover.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 min-h-11 rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-neutral-200"
            >
              Reload Pullio
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
