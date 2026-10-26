import { Component, type ReactNode } from 'react';

interface State {
  error?: Error;
}

/** Last line of defence: shows what happened and a way out, instead of leaving a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Unhandled error', error, info.componentStack);
  }

  private reset = async () => {
    if (!window.confirm('This deletes the mockups, designs and settings saved in this browser. Continue?')) return;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('reskin-mockups');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The app hit an unexpected error. Your files are still saved in this browser, so reloading usually fixes it.</p>
        <pre>{this.state.error.message}</pre>
        <div className="crash-actions">
          <button className="btn accent" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn" onClick={this.reset}>
            Delete saved data and reload
          </button>
        </div>
      </div>
    );
  }
}
