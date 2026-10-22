// Studio's light palette: one meaning per colour across the 3D scene, the canvases and the CSS legends.
// It follows the public site (site/js/viewer.js COLORS, site/css/stage.css) so the two read as one product.
// CSS mirrors the UI and series values as custom properties in styles.css (--text, --c-ref, ...).

// Interface: ink on white, hairline borders, one accent.
export const UI = {
  ink: '#10161c', muted: '#4a5561', dim: '#66717d', faint: '#8f99a4',
  panel: '#ffffff', panel2: '#f7f9fb', canvas: '#fbfcfd', line: '#e3e8ed', grid: '#eef1f4', strong: '#c9d2db',
  accent: '#2456e6', ok: '#1f9d5a', warn: '#c27c0e', bad: '#d14343',
  // Darker forms for small text on white (AA).
  okText: '#17824a', warnText: '#9a5f06', badText: '#c23434',
};

// Data series. The reference (what SONIC is asked to track) is pink, as the site's "Plan body"; planned futures are
// amber; the executed path is teal; configured geometry is slate.
export const SERIES = {
  robot: '#2a333d', reference: '#e8458f', ghost: '#ff7fc4', future: '#e0a030', path: '#9aa8b6', travelled: '#0f9e94',
  goal: '#e0a030', start: '#2a333d', box: '#9aa8b6', boxEdge: '#6f7f8e', overhead: '#b7a5cf', overheadEdge: '#8a6fb5',
  support: '#2fae6a', ceiling: '#9d7cc9', planner: '#9d7cc9', sonic: '#0f9e94', tracking: '#5f6975', contact: '#dc5348',
  blue: '#2f74d0', violet: '#9d7cc9', green: '#2fae6a', red: '#dc5348',
};

// Run comparison colours (Runs workspace, 3D overlay): distinct on white, none of them the accent.
export const RUN_COLORS = ['#0f9e94', '#9d7cc9', '#e0a030', '#2f74d0', '#2fae6a', '#dc5348'];

export const hex = css => parseInt(css.slice(1, 7), 16);
export const alpha = (css, a) => `${css.slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
