// The auto-align UI: a button that starts screen capture, and a floating
// panel with the status line, a diagnostics line and verdict history (what
// OCR is actually reading, and why a reading was or wasn't applied), the
// preview canvas (drag on it to override the auto-detected crop), a
// collapse tab, and Stop. All capture, timers, and OCR live in
// useAligner.ts -- this component only renders its state.
import { useState } from "react";

import { Pill } from "../components/Pill.tsx";
import { useNarrowViewport } from "../lib/useNarrowViewport.ts";
import styles from "./AlignPanel.module.css";
import type { Diagnostics } from "./useAligner.ts";
import { useAligner } from "./useAligner.ts";

/** No styling beyond the muted colour a CSS class already gives the whole
 * line -- plain text, quoting whatever OCR last produced (or its error). */
function diagnosticsLine(diagnostics: Diagnostics): string {
  if (diagnostics.lastSampleAt === null) return "OCR: no samples yet";
  const quoted = diagnostics.lastError ?? diagnostics.lastText ?? "";
  const secondsAgo = Math.max(0, Math.round((Date.now() - diagnostics.lastSampleAt) / 1000));
  return `OCR: "${quoted}" · ${secondsAgo}s ago · reads ${diagnostics.accepted}/${diagnostics.attempts}`;
}

export function AlignPanel() {
  const { phase, status, diagnostics, visible, previewCanvasRef, onPreviewPointerDown, onPreviewPointerUp, start, stop } = useAligner();
  // Collapsed to its tab by default under the narrow breakpoint -- the
  // experimental preview canvas otherwise crowds a phone-width board;
  // still a plain toggle from there, same as the wide layout.
  const narrow = useNarrowViewport();
  const [collapsed, setCollapsed] = useState(narrow);

  if (!visible) {
    return (
      <button type="button" className={styles.startButton} onClick={start}>
        📺 Align with my screen <Pill tone="warn">experimental</Pill>
      </button>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          Align with my screen <Pill tone="warn">experimental</Pill>
        </span>
        <button
          type="button"
          className={styles.collapseTab}
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className={styles.status} role="status">
            {status}
          </div>
          <div className={styles.diagnostics}>{diagnosticsLine(diagnostics)}</div>
          {diagnostics.history.length > 0 && (
            <ul className={styles.history}>
              {diagnostics.history.map((label, index) => (
                <li key={index}>{label}</li>
              ))}
            </ul>
          )}
          <canvas
            ref={previewCanvasRef}
            className={styles.preview}
            aria-label="Broadcast preview"
            onPointerDown={onPreviewPointerDown}
            onPointerUp={onPreviewPointerUp}
          />
        </>
      )}
      {/* A capture failure resets phase to "idle" but keeps the panel
          visible so the status is seen -- offer a retry here instead of
          Stop. */}
      {phase === "idle" ? (
        <button type="button" className={styles.stopButton} onClick={start}>
          Align with my screen
        </button>
      ) : (
        <button type="button" className={styles.stopButton} onClick={stop}>
          Stop
        </button>
      )}
    </div>
  );
}
