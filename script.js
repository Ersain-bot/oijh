const $ = id => document.getElementById(id);
const el = { score: $('eval-score'), fill: $('eval-fill'), label: $('eval-label'), bar: $('eval-bar'),
  fen: $('fen-input'), pgn: $('pgn-input'), moves: $('moves'), msg: $('msg'), arrow: $('arrow'),
  depth: $('depth'), depthVal: $('depth-val'), depthInfo: $('depth-info'), on: $('engine-on'), promo: $('promo'),
  lines: [$('line-1'), $('line-2'), $('line-3')] };

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// State: a single mainline starting at startFen; fens[i] is the position after i moves.
let startFen = DEFAULT_FEN, line = [], fens = [DEFAULT_FEN], ply = 0, flipped = false;

const board = Chessboard('board', {
  draggable: true, position: 'start',
  pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png', // original had no pieceTheme -> pieces failed to load
  onDragStart, onDrop, onSnapEnd: () => board.position(fens[ply], false)
});
window.addEventListener('resize', () => { board.resize(); drawArrow(); });

function say(text, err) { el.msg.textContent = text || ''; el.msg.className = 'muted' + (err ? ' err' : ''); }

/* ---------- position / navigation ---------- */
function setLine(fen, sans) {
  const g = new Chess(fen);
  startFen = fen; line = []; fens = [fen];
  for (const san of sans) {
    const m = g.move(san, { sloppy: true });
    if (!m) break;
    line.push(m); fens.push(g.fen());
  }
  ply = line.length;
  render();
}
function go(n) { ply = Math.max(0, Math.min(line.length, n)); render(); }

function onDragStart(source, piece) {
  const g = new Chess(fens[ply]);
  if (g.game_over()) return false;
  return (g.turn() === 'w') === piece.startsWith('w');
}
function onDrop(from, to) {
  const g = new Chess(fens[ply]);
  const piece = g.get(from);
  const needsPromo = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1');
  const m = g.move({ from, to, promotion: needsPromo ? el.promo.value : undefined });
  if (!m) return 'snapback';
  line = line.slice(0, ply); fens = fens.slice(0, ply + 1); // a new move discards the old continuation
  line.push(m); fens.push(g.fen()); ply++;
  setTimeout(render, 0);
}

function render() {
  const fen = fens[ply];
  board.position(fen, false);
  el.fen.value = fen;
  const g = new Chess(startFen); line.forEach(m => g.move(m));
  el.pgn.value = g.pgn();
  document.querySelectorAll('#board .hl').forEach(s => s.classList.remove('hl'));
  if (ply > 0) { const m = line[ply - 1]; [m.from, m.to].forEach(s => { const q = document.querySelector('#board .square-' + s); if (q) q.classList.add('hl'); }); }
  renderMoves();
  clearEngine();
  const cur = new Chess(fen);
  if (cur.game_over()) {
    const t = cur.in_checkmate() ? 'Мат' : 'Ничья';
    el.lines[0].textContent = t; setEval(cur.in_checkmate() ? (cur.turn() === 'w' ? -1e4 : 1e4) : 0, t);
  } else analyze();
}

function renderMoves() {
  el.moves.innerHTML = '';
  if (!line.length) { el.moves.innerHTML = '<span class="muted">Сделайте ход или загрузите партию</span>'; return; }
  const first = parseInt(startFen.split(' ')[5]) || 1, blackFirst = startFen.split(' ')[1] === 'b';
  line.forEach((m, i) => {
    const white = (i % 2 === 0) !== blackFirst;
    if (white || i === 0) {
      const n = document.createElement('span'); n.className = 'n';
      n.textContent = first + Math.floor((i + (blackFirst ? 1 : 0)) / 2) + (white ? '.' : '…'); el.moves.append(n);
    }
    const b = document.createElement('button'); b.className = 'mv' + (i + 1 === ply ? ' on' : '');
    b.textContent = m.san; b.onclick = () => go(i + 1); el.moves.append(b);
  });
  const on = el.moves.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}

/* ---------- engine ---------- */
let engine = null, busy = false, pending = null, searchFen = null, best = null;

fetch('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js')
  .then(r => { if (!r.ok) throw 0; return r.text(); })
  .then(code => {
    engine = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    engine.onmessage = e => onEngine(typeof e.data === 'string' ? e.data : '');
    engine.postMessage('uci');
    engine.postMessage('setoption name MultiPV value 3');
    engine.postMessage('isready');
    analyze();
  })
  .catch(() => { el.lines[0].textContent = 'Не удалось загрузить движок (проверьте интернет).'; });

function clearEngine() { el.lines.forEach(l => l.textContent = ''); el.depthInfo.textContent = ''; best = null; drawArrow(); }

function analyze() {
  if (!engine) return;
  if (!el.on.checked) { el.lines[0].textContent = 'Движок выключен'; return; }
  el.lines[0].textContent = 'Анализ…';
  pending = fens[ply];
  if (busy) engine.postMessage('stop'); else startSearch(); // wait for 'bestmove' so stale results never leak into the new position
}
function startSearch() {
  searchFen = pending; pending = null; busy = true;
  engine.postMessage('position fen ' + searchFen);
  engine.postMessage('go depth ' + el.depth.value);
}
function onEngine(msg) {
  if (msg.startsWith('bestmove')) { busy = false; if (pending) startSearch(); return; }
  if (pending || !msg.startsWith('info') || !msg.includes(' pv ') || !msg.includes('score')) return;
  const idx = +(msg.match(/multipv (\d+)/) || [0, 1])[1] - 1;
  if (idx > 2) return;
  const sign = searchFen.split(' ')[1] === 'w' ? 1 : -1;
  const cp = msg.match(/score cp (-?\d+)/), mate = msg.match(/score mate (-?\d+)/);
  let text, val;
  if (cp) { val = sign * +cp[1]; text = (val > 0 ? '+' : '') + (val / 100).toFixed(2); }
  else if (mate) { const n = +mate[1]; val = sign * (n > 0 ? 1e4 - n : -1e4 - n); text = (sign * n > 0 ? '+' : '−') + 'M' + Math.abs(n); }
  else return;
  const uci = msg.match(/ pv (.*)/)[1].trim().split(' ');
  el.lines[idx].innerHTML = `<b>${text}</b>${pvToSan(uci, searchFen)}`;
  if (idx === 0) {
    setEval(val, text); best = uci[0]; drawArrow();
    el.depthInfo.textContent = 'глубина ' + msg.match(/depth (\d+)/)[1];
  }
}

function pvToSan(uci, fen) {
  const g = new Chess(fen), out = [];
  let n = parseInt(fen.split(' ')[5]) || 1, first = true;
  for (const u of uci.slice(0, 10)) {
    const white = g.turn() === 'w';
    const m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    if (!m) break;
    if (white) out.push(n + '. ' + m.san); else { out.push((first ? n + '… ' : '') + m.san); n++; }
    first = false;
  }
  return out.join(' ');
}

/* ---------- eval bar & arrow ---------- */
function setEval(cp, text) {
  el.score.textContent = text;
  const pct = Math.abs(cp) >= 9000 ? (cp > 0 ? 100 : 0) : 100 / (1 + Math.exp(-cp / 400)); // smooth curve instead of linear +-10 pawns
  el.fill.style.height = pct + '%';
  el.label.textContent = Math.abs(cp) >= 9000 ? text.replace('+', '') : Math.abs(cp / 100).toFixed(1);
  el.bar.classList.toggle('neg', cp < 0);
}
function sq(s) { // square -> centre in 8x8 viewBox
  let x = s.charCodeAt(0) - 97, y = 8 - +s[1];
  if (flipped) { x = 7 - x; y = 7 - y; }
  return [x + .5, y + .5];
}
function drawArrow() {
  if (!best) { el.arrow.setAttribute('visibility', 'hidden'); return; }
  const [x1, y1] = sq(best.slice(0, 2)), [x2, y2] = sq(best.slice(2, 4));
  const d = Math.hypot(x2 - x1, y2 - y1), k = (d - .15) / d; // shorten so the head lands inside the square
  el.arrow.setAttribute('x1', x1); el.arrow.setAttribute('y1', y1);
  el.arrow.setAttribute('x2', x1 + (x2 - x1) * k); el.arrow.setAttribute('y2', y1 + (y2 - y1) * k);
  el.arrow.setAttribute('visibility', 'visible');
}

/* ---------- controls ---------- */
$('first').onclick = () => go(0);
$('prev').onclick = () => go(ply - 1);
$('next').onclick = () => go(ply + 1);
$('last').onclick = () => go(line.length);
$('flip').onclick = () => { flipped = !flipped; board.flip(); el.bar.classList.toggle('flipped', flipped); render(); };
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const k = { ArrowLeft: () => go(ply - 1), ArrowRight: () => go(ply + 1), Home: () => go(0), End: () => go(line.length), f: () => $('flip').click() }[e.key];
  if (k) { e.preventDefault(); k(); }
});
el.on.onchange = () => el.on.checked ? analyze() : (engine && busy && engine.postMessage('stop'), pending = null, clearEngine(), el.lines[0].textContent = 'Движок выключен');
el.depth.oninput = () => { el.depthVal.textContent = el.depth.value; };
el.depth.onchange = () => { if (el.on.checked && !new Chess(fens[ply]).game_over()) analyze(); };

$('load-fen-btn').onclick = () => {
  const fen = el.fen.value.trim(), v = new Chess().validate_fen(fen);
  if (!v.valid) return say('Некорректный FEN: ' + v.error, true);
  setLine(fen, []); say('FEN загружен');
};
$('load-pgn-btn').onclick = () => {
  const g = new Chess();
  if (!g.load_pgn(el.pgn.value.trim(), { sloppy: true })) return say('Некорректный PGN', true);
  setLine(g.header().FEN || DEFAULT_FEN, g.history()); say(`Загружено ходов: ${line.length}`); go(0);
};
$('reset-btn').onclick = () => { setLine(DEFAULT_FEN, []); say(''); };

render();
