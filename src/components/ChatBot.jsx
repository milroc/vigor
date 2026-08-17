import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { sendChat } from '../api.js';
import s from './ChatBot.module.css';

// Rasterize the telemetry charts exactly as rendered. Charts are found by
// the data-chart marker LineChart sets (their viewBox tracks the measured
// container size, so it can't be matched on). SVG styling lives in external
// CSS modules, so computed styles are inlined first.
async function captureCharts() {
  const svgs = [...document.querySelectorAll('svg[data-chart]')];
  if (!svgs.length) return null;
  const SCALE = 1.5, GAP = 12;
  const sizes = svgs.map(el => {
    const r = el.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(...sizes.map(d => d.w)) * SCALE;
  canvas.height = sizes.reduce((a, d) => a + d.h * SCALE + GAP, 0);
  const g = canvas.getContext('2d');
  g.fillStyle = '#0a0a08'; g.fillRect(0, 0, canvas.width, canvas.height);
  const PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-dasharray', 'stroke-linejoin', 'opacity', 'font-family', 'font-size',
    'font-weight', 'letter-spacing'];
  let yOff = 0;
  for (let i = 0; i < svgs.length; i++) {
    const srcSvg = svgs[i], clone = srcSvg.cloneNode(true);
    const sEls = [srcSvg, ...srcSvg.querySelectorAll('*')];
    const cEls = [clone, ...clone.querySelectorAll('*')];
    sEls.forEach((el, j) => {
      const cs = getComputedStyle(el);
      let style = '';
      for (const prop of PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v) style += `${prop}:${v};`;
      }
      cEls[j].setAttribute('style', style);
    });
    const { w, h } = sizes[i];
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    const url = URL.createObjectURL(new Blob(
      [new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }
    ));
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { g.drawImage(img, 0, yOff, w * SCALE, h * SCALE); resolve(); };
        img.onerror = reject;
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    yOff += h * SCALE + GAP;
  }
  return canvas.toDataURL('image/png');
}

export default function ChatBot({ context }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const screenshot = await captureCharts().catch(() => null);
      const { reply } = await sendChat(next, context, screenshot);
      setMessages(m => [...m, { role: 'assistant', text: reply }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.wrap}>
      <button className={s.titleBar} onClick={() => setOpen(o => !o)}>
        <span className={s.title}>Coach <span>▮</span></span>
        <span className={s.status}>
          {busy ? 'thinking…' : messages.length > 0 ? `${messages.length} messages` : ''}
        </span>
        <span className={s.chevron}>{open ? '▼' : '▲'}</span>
      </button>
      {open && (
        <>
          {messages.length === 0 && (
            <div className={s.hint}>
              Ask anything about this exercise, your targets, or how to read the charts.
            </div>
          )}
          {messages.length > 0 && (
            <div className={s.log} ref={logRef}>
              {messages.map((m, i) => (
                <div key={i} className={`${s.msg} ${m.role === 'user' ? s.user : s.coach}`}>
                  {m.role === 'assistant' ? <Markdown>{m.text}</Markdown> : m.text}
                </div>
              ))}
              {busy && <div className={`${s.msg} ${s.pending}`}>coach is thinking…</div>}
              {error && <div className={`${s.msg} ${s.error}`}>error: {error}</div>}
            </div>
          )}
          <div className={s.inputRow}>
            <input
              value={input}
              placeholder="e.g. why is my eccentric slower on late reps?"
              maxLength={2000}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }}
              autoFocus
            />
            <button onClick={send} disabled={busy || !input.trim()}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
