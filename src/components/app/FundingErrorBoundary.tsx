"use client";

import { Component, type ReactNode } from "react";

/**
 * Failure containment for the Funding card. If any funding child throws
 * during render (e.g. a DTO shape the inline guards didn't expect), only
 * this card falls back — the campaign route stays up. The fallback offers
 * a retry that remounts the children from a clean state.
 */
export class FundingErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; nonce: number }
> {
  state = { failed: false, nonce: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="form-error" role="alert" style={{ fontSize: 14 }}>
            Funding preview couldn&apos;t be prepared.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => this.setState({ failed: false, nonce: this.state.nonce + 1 })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <div key={this.state.nonce}>{this.props.children}</div>;
  }
}
