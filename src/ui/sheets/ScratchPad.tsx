// Free scratch pad: a canvas to write on, no grading, optional 田字格 grid.
import { useCallback, useEffect, useRef, useState } from 'react';

type Pt = [number, number]; // x, y as fractions of the canvas, so a resize keeps the drawing

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function ScratchPad({ grid = true, height = 280 }: { grid?: boolean; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const current = useRef<Pt[] | null>(null);
  const [showGrid, setShowGrid] = useState(grid);
  const [count, setCount] = useState(0);

  const draw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.width / dpr;
    const h = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (showGrid) {
      ctx.strokeStyle = cssVar('--grid', '#e1aaa3');
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = cssVar('--ink', '#1b231f');
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.arc(s[0][0] * w, s[0][1] * h, 2.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      ctx.stroke();
    }
  }, [showGrid]);

  // Size the canvas to its box with device-pixel scaling.
  useEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      if (!w) return;
      c.width = Math.round(w * dpr);
      c.height = Math.round(height * dpr);
      draw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height, draw]);

  const point = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvas.current?.setPointerCapture(e.pointerId);
    current.current = [point(e)];
    draw();
  };
  const move = (e: React.PointerEvent) => {
    if (!current.current) return;
    e.preventDefault();
    current.current.push(point(e));
    draw();
  };
  const up = () => {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    setCount(strokes.current.length);
    draw();
  };

  const undo = () => {
    strokes.current.pop();
    setCount(strokes.current.length);
    draw();
  };
  const clear = () => {
    strokes.current = [];
    setCount(0);
    draw();
  };

  return (
    <div className="sp">
      <div className="sp-box" ref={wrap} style={{ height }}>
        <canvas
          ref={canvas}
          className="sp-canvas"
          style={{ height }}
          role="img"
          aria-label="Scratch pad: draw with your finger or mouse"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
      <div className="row sp-tools">
        <button type="button" className="btn grow" onClick={undo} disabled={!count}>
          Undo stroke
        </button>
        <button type="button" className="btn grow" onClick={clear} disabled={!count}>
          Clear
        </button>
        <button type="button" className="btn grow" aria-pressed={showGrid} onClick={() => setShowGrid((g) => !g)}>
          Grid {showGrid ? 'on' : 'off'}
        </button>
      </div>
    </div>
  );
}
