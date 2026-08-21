import { Component, useEffect, useRef, useState } from 'react';
import { listAnalyses, getAnalysis, runAdhocAgent, saveAnalysis, deleteAnalysis, queryHealth } from '../api.js';
import LineChart from '../components/LineChart.jsx';
import BarChart from '../components/BarChart.jsx';
import shared from '../styles/shared.module.css';
import a from './AdHoc.module.css';

let CID = 1;
const newCell = (patch = {}) => ({ cid: CID++, title: '', sql: '', cols: [], rows: [], rowCount: 0, err: null, running: false, hasRun: false, viz: null, ...patch });
const toTable = objs => {
  const cols = objs.length ? Object.keys(objs[0]) : [];
  return { cols, rows: objs.map(r => cols.map(c => r[c])), rowCount: objs.length };
};

const Cell = ({ cell }) => {
  if (cell != null && typeof cell === 'object' && 'v' in cell) return <span className={cell.tone ? a[cell.tone] : undefined}>{cell.v}</span>;
  const s = cell == null || cell === '' ? '—' : cell;
  return <>{typeof s === 'number' ? s.toLocaleString() : s}</>;
};
const Table = ({ columns, rows }) => (
  <table className={shared.table}>
    <thead><tr>{columns.map((c, j) => <th key={j} className={j ? shared.num : undefined}>{c}</th>)}</tr></thead>
    <tbody>{rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i} className={i ? shared.num : undefined}><Cell cell={c} /></td>)}</tr>)}</tbody>
  </table>
);

// ---- charting: map a cell's SQL result to a line/bar chart ----
const PALETTE = ['#c6fe28', '#4da3ff', '#ff6b9d', '#3fd8c7', '#f78e1e', '#b48aff'];
const isNum = v => v != null && v !== '' && !isNaN(Number(v));
const numericIdx = (cols, rows) => cols.map((_, i) => i)
  .filter(i => rows.length && rows.every(r => r[i] == null || r[i] === '' || isNum(r[i])) && rows.some(r => isNum(r[i])));
const shortX = v => { const s = String(v ?? ''); return s.length > 10 ? s.slice(0, 10) : s; };

// Resolve x column + y columns from an explicit viz spec, else auto-detect
// (first non-numeric column = x, all numeric columns = y).
function axesFor({ cols, rows, viz }) {
  const nums = numericIdx(cols, rows);
  let xi = viz?.x ? cols.indexOf(viz.x) : -1;
  if (xi < 0) xi = cols.findIndex((_, i) => !nums.includes(i));
  if (xi < 0) xi = 0;
  let yIdx = (viz?.y || []).map(c => cols.indexOf(c)).filter(i => i >= 0);
  if (!yIdx.length) yIdx = nums.filter(i => i !== xi);
  return { xi, yIdx };
}

// A bad chart must never blank the whole page — fall back to a message.
class ChartBoundary extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() { return this.state.err ? <div className={a.cellEmpty}>Can’t chart this result — try Table.</div> : this.props.children; }
}

function CellChart({ cell }) {
  const { cols, rows } = cell;
  const { xi, yIdx } = axesFor(cell);
  if (!rows.length || !yIdx.length) return <div className={a.cellEmpty}>Nothing numeric to plot — try a table.</div>;
  if (cell.viz?.type === 'bar') {
    const bars = rows.map(r => ({ label: shortX(r[xi]), a: Number(r[yIdx[0]]) || 0, b: yIdx[1] != null ? Number(r[yIdx[1]]) || 0 : undefined }));
    return <div className={a.chartWrap}><BarChart bars={bars} fmt={v => Number.isInteger(v) ? v : (+v).toFixed(1)}
      legendA={cols[yIdx[0]]} legendB={yIdx[1] != null ? cols[yIdx[1]] : undefined} /></div>;
  }
  const seriesList = yIdx.map((yi, k) => ({
    samples: rows.map((r, i) => ({ t: i, v: isNum(r[yi]) ? Number(r[yi]) : null })).filter(p => p.v != null),
    color: PALETTE[k % PALETTE.length], width: 2, label: cols[yi],
  })).filter(s => s.samples.length);
  return <div className={a.chartWrap}><LineChart
    title={cell.title || `chart-${cell.cid}`} unit={cols[xi] || ''}
    seriesList={seriesList} color={PALETTE[0]}
    xLabelLeft={shortX(rows[0]?.[xi])} xLabel={shortX(rows[rows.length - 1]?.[xi])}
    tipT={t => shortX(rows[Math.max(0, Math.min(rows.length - 1, Math.round(t)))]?.[xi])}
  /></div>;
}

export default function AdHoc() {
  const [analyses, setAnalyses] = useState(null);
  const [selName, setSelName] = useState(null);
  const [view, setView] = useState(null);        // built-in run result
  const [nb, setNb] = useState(null);             // editable notebook or null
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showSource, setShowSource] = useState(false);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const chatRef = useRef(null);

  const refreshList = () => listAnalyses().then(d => setAnalyses(d.analyses)).catch(e => setError(e.message));
  useEffect(() => { refreshList(); }, []);
  useEffect(() => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, agentBusy]);

  // Result patches keep the notebook clean (not "dirty"); edits mark dirty.
  const setCell = (cid, patch) => setNb(n => n ? { ...n, cells: n.cells.map(c => c.cid === cid ? { ...c, ...patch } : c) } : n);
  const patchCell = (cid, patch) => setNb(n => ({ ...n, dirty: true, cells: n.cells.map(c => c.cid === cid ? { ...c, ...patch } : c) }));
  const addCell = (cell = newCell()) => setNb(n => n ? { ...n, dirty: true, cells: [...n.cells, cell] } : n);
  const removeCell = cid => setNb(n => ({ ...n, dirty: true, cells: n.cells.filter(c => c.cid !== cid) }));

  // Takes the cell object (not an id) so it works even before setNb commits.
  const runCell = async cell => {
    if (!cell?.sql?.trim()) return;
    setCell(cell.cid, { running: true, err: null });
    try {
      const { cols, rows, rowCount } = toTable(await queryHealth(cell.sql));
      setCell(cell.cid, { cols, rows, rowCount, err: null, running: false, hasRun: true });
    } catch (e) {
      setCell(cell.cid, { err: e.message, running: false, hasRun: true });
    }
  };

  const openBuiltin = name => {
    setLoading(true); setError(null); setNb(null); setView(null);
    getAnalysis(name).then(r => setView(r)).catch(e => setError(e.message)).finally(() => setLoading(false));
  };
  const openSaved = name => {
    setLoading(true); setError(null); setView(null);
    getAnalysis(name).then(def => {
      const cells = (def.cells || []).map(c => newCell({ title: c.title, sql: c.sql, viz: c.viz || null }));
      setNb({ name: def.name, title: def.title, description: def.description || '', cells, dirty: false });
      cells.forEach(c => runCell(c));
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  };
  const select = item => { setSelName(item.name); item.kind === 'saved' ? openSaved(item.name) : openBuiltin(item.name); };
  const newAnalysis = () => { setSelName(null); setView(null); setError(null); setNb({ name: null, title: 'Untitled analysis', description: '', cells: [newCell({ title: 'Cell 1' })], dirty: true }); };

  // default selection once
  useEffect(() => { if (analyses && selName == null && !nb && analyses[0]) select(analyses[0]); /* eslint-disable-next-line */ }, [analyses]);

  const addCellFromAgent = d => {
    const cell = newCell({ title: d.title, sql: d.sql, cols: d.columns, rows: d.rows, rowCount: d.rowCount, hasRun: true, viz: d.viz || null });
    if (nb) { addCell(cell); return; }
    setNb({ name: null, title: d.title || 'New analysis', description: d.explanation || '', cells: [cell], dirty: true });
    setSelName(null); setView(null);
  };
  const ask = async (text, history) => {
    const convo = [...(history ?? messages), { role: 'user', text }];
    setMessages(convo); setInput(''); setAgentBusy(true);
    try {
      const d = await runAdhocAgent(convo);
      addCellFromAgent(d);
      setMessages([...convo, { role: 'assistant', text: `Added a cell: ${d.title}. ${d.explanation || ''}` }]);
    } catch (e) {
      setMessages([...convo, { role: 'assistant', text: `⚠ ${e.message}` }]);
    } finally { setAgentBusy(false); }
  };
  const send = () => { const t = input.trim(); if (t && !agentBusy) ask(t); };

  const save = async () => {
    try {
      const entry = await saveAnalysis({ name: nb.name, title: nb.title, description: nb.description, cells: nb.cells.map(({ title, sql, viz }) => ({ title, sql, ...(viz ? { viz } : {}) })) });
      setNb(n => ({ ...n, name: entry.name, dirty: false }));
      setSelName(entry.name);
      await refreshList();
    } catch (e) { setError(e.message); }
  };
  const remove = async (e, name) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${name}"?`)) return;
    await deleteAnalysis(name).catch(() => {});
    if (selName === name) { setNb(null); setView(null); setSelName(null); }
    refreshList();
  };

  if (error && !analyses) return <main className={a.wrapErr}><div className={shared.panel}>{error}</div></main>;
  if (!analyses) return <main className={a.wrapErr} />;
  const data = view?.data;

  return (
    <div className={a.layout}>
      {/* sidebar */}
      <aside className={a.side}>
        <h1 className={a.brand}>◆ Ad-hoc Analysis</h1>
        <button className={a.newBtn} onClick={newAnalysis}>+ New analysis</button>
        <div className={a.list}>
          {analyses.map(x => (
            <div key={x.name} className={`${a.item} ${selName === x.name ? a.on : ''}`}
              role="button" tabIndex={0} onClick={() => select(x)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(x); } }}>
              <div className={a.itemMain}>
                <div className={a.ti}>{x.title}</div>
                <div className={a.mi}>{x.kind === 'saved' ? 'notebook · editable' : 'built-in module'}</div>
              </div>
              {x.kind === 'saved' && <button className={a.del} title="delete" onClick={e => remove(e, x.name)}>✕</button>}
            </div>
          ))}
        </div>
      </aside>

      {/* notebook / view */}
      <main className={a.main}>
        <div className={a.wrap}>
          {error && <div className={a.inlineErr}>{error}</div>}
          {loading && <div className={a.loading}>● loading…</div>}

          {/* editable notebook */}
          {nb && (
            <>
              <div className={a.editHead}>
                <input className={a.titleInput} value={nb.title} onChange={e => setNb(n => ({ ...n, title: e.target.value, dirty: true }))} placeholder="Analysis title" />
                <div className={a.saveRow}>
                  {nb.dirty && <span className={a.dirty}>● unsaved</span>}
                  <button className={`${a.abtn} ${a.pri}`} onClick={save} disabled={!nb.title.trim() || !nb.cells.some(c => c.sql.trim())}>⤓ Save</button>
                </div>
              </div>
              <input className={a.descInput} value={nb.description} onChange={e => setNb(n => ({ ...n, description: e.target.value, dirty: true }))} placeholder="Short description (optional)" />

              {nb.cells.map((c, i) => (
                <div key={c.cid} className={a.cell}>
                  <div className={a.cellHd}>
                    <input className={a.cellTitle} value={c.title} placeholder={`Cell ${i + 1}`} onChange={e => patchCell(c.cid, { title: e.target.value })} />
                    <button className={a.cellBtn} onClick={() => runCell(c)} disabled={c.running || !c.sql.trim()}>{c.running ? '…' : '▶ Run'}</button>
                    <button className={a.cellBtn} onClick={() => removeCell(c.cid)}>✕</button>
                  </div>
                  <textarea
                    className={a.sqlInput} value={c.sql} spellCheck={false}
                    placeholder="SELECT … FROM ah_workouts   (read-only · ⌘↵ to run)"
                    onChange={e => patchCell(c.cid, { sql: e.target.value })}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runCell(c); }}
                  />
                  {c.err && <div className={a.cellErr}>{c.err}</div>}
                  {!c.err && c.hasRun && (c.cols.length ? (
                    <div className={a.cellOut}>
                      <div className={a.vizBar}>
                        {['table', 'line', 'bar'].map(vt => (
                          <button key={vt} className={`${a.vizBtn} ${(c.viz?.type || 'table') === vt ? a.vizOn : ''}`}
                            onClick={() => patchCell(c.cid, { viz: vt === 'table' ? null : { ...(c.viz || {}), type: vt } })}>{vt}</button>
                        ))}
                      </div>
                      {c.viz?.type === 'line' || c.viz?.type === 'bar'
                        ? <ChartBoundary key={`${c.cid}-${c.viz.type}`}><CellChart cell={c} /></ChartBoundary>
                        : <div className={a.cellResult}><Table columns={c.cols} rows={c.rows} /></div>}
                    </div>
                  ) : <div className={a.cellEmpty}>0 rows</div>)}
                </div>
              ))}
              <button className={a.addCell} onClick={() => addCell()}>+ Add cell</button>
              <p className={a.tip}>Write SQL over the parquet views, or ask the agent (right) to draft a cell. ⌘↵ runs a cell.</p>
            </>
          )}

          {/* built-in read-only view */}
          {!nb && view && (
            <>
              <div className={a.head}>
                <h2 className={shared.title}>{view.title}</h2>
                <p className={a.desc}>{view.description}</p>
                <div className={a.meta}><span className={`${a.pill} ${a.ok}`}>● parquet · ready</span><span className={a.pill}>built-in</span><button className={a.pill} onClick={() => openBuiltin(view.name)}>⟳ Re-run</button></div>
              </div>
              {data?.sections?.map((sec, i) => (
                <section key={i} className={a.block}>
                  <div className={a.bhd}><h3>{sec.title}</h3>{sec.note && <span className={a.note}>{sec.note}</span>}</div>
                  <div className={a.card}><Table columns={sec.columns} rows={sec.rows} /></div>
                </section>
              ))}
              {data?.notes?.length > 0 && (
                <section className={a.block}><div className={a.bhd}><h3>Caveats</h3></div><ul className={a.notes}>{data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></section>
              )}
              {view.source?.length > 0 && (
                <section className={a.block}>
                  <div className={a.bhd}><h3>Source</h3><button className={a.codeToggle} onClick={() => setShowSource(v => !v)}>{showSource ? 'hide' : 'show'} · {view.source.map(x => x.file).join(', ')}</button></div>
                  {showSource && view.source.map(x => <div key={x.file} className={a.sourceBlock}><div className={a.sourceFile}>{x.file}</div><pre className={a.code}>{x.code}</pre></div>)}
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {/* agent panel */}
      <aside className={a.agent}>
        <div className={a.ahead}><span className={a.at}>✦ Agent</span><span className={a.model}>claude · parquet tools</span></div>
        <div className={a.chat} ref={chatRef}>
          {messages.length === 0 && (
            <div className={a.empty}>
              Ask for an analysis in plain English. The agent writes a read-only query over your parquet
              views, runs it, and drops the result in as an editable cell — {nb ? 'added to this notebook.' : 'starting a new notebook.'}
              <div className={a.egs}>
                {['Resting HR by month in 2026', 'Cycling minutes per week this year', 'Steps: weekday vs weekend by year'].map(e => (
                  <button key={e} className={a.eg} onClick={() => ask(e)}>{e}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={a.msg}><div className={a.who}>{m.role === 'assistant' ? 'Agent' : 'You'}</div>
              <div className={m.role === 'user' ? a.userBubble : a.aiBubble}>{m.text}</div></div>
          ))}
          {agentBusy && <div className={a.thinking}>● writing query…</div>}
        </div>
        <div className={a.composer}>
          <textarea className={a.box} value={input} placeholder="Ask the agent to analyze…" onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} />
          <div className={a.crow}><span className={a.hint}>read-only · ⌘↵ to run</span>
            <button className={a.send} onClick={send} disabled={agentBusy || !input.trim()}>Send</button></div>
        </div>
      </aside>
    </div>
  );
}
