"use client";

import { Component, type ReactNode } from "react";

/**
 * Contains a map failure inside the map panel.
 *
 * Without this, a throw during MapLibre's render or WebGL initialisation unmounts
 * the whole workspace and takes the itinerary — the part that still works
 * perfectly — down with it. React error boundaries have to be class components;
 * there is no hook equivalent.
 */
export class MapErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Rendered instead of the children once a render has thrown. */
    fallback: ReactNode;
    onError?: (error: Error) => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    // Diagnostics for development only; users see the plain-language fallback.
    if (process.env.NODE_ENV !== "production") {
      console.error("[roamly] map render failed", error);
    }
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
