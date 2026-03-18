import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error.message, error.stack, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: "16px",
          backgroundColor: "var(--bg)",
          color: "var(--text)",
          fontFamily: "inherit",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <AlertTriangle size={48} style={{ color: "var(--accent)" }} />
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
          Something went wrong
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: "13px",
            color: "var(--text-secondary)",
            maxWidth: "480px",
            lineHeight: 1.5,
          }}
        >
          An unexpected error occurred
        </p>
        <button
          onClick={this.handleReload}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            marginTop: "8px",
            padding: "8px 20px",
            backgroundColor: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            borderRadius: "8px",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={16} />
          Reload
        </button>
      </div>
    );
  }
}
