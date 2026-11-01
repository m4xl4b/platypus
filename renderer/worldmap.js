// Mappa della realtà di un agente: territorio con la nebbia di guerra + traiettoria nello spazio degli stati.
// Si apre con openWorldMap(sid, aid) (dalla scheda di un agente o con il tasto G).
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const LOCALE = (window.AO_I18N && AO_I18N.locale) || 'it-IT';

  const PHASES = {
    explore: { label: tr('ESPLORA'), col: '#29ADFF', help: tr('Apre cose nuove per capire il problema') },
    study: { label: tr('STUDIA'), col: '#83769C', help: tr('Rilegge quello che conosce già') },
    build: { label: tr('COSTRUISCE'), col: '#FFEC27', help: tr('Modifica e crea file') },
    verify: { label: tr('VERIFICA'), col: '#00E436', help: tr('Lancia test e controlli') },
    struggle: { label: tr('IN DIFFICOLTÀ'), col: '#FFA300', help: tr('Molti errori di fila') },
    stuck: { label: tr('IN LOOP'), col: '#FF004D', help: tr('Ripete le stesse azioni senza venirne a capo') },
    orient: { label: tr('SI ORIENTA'), col: '#C2C3C7', help: tr('Un po\' di tutto: sta decidendo cosa fare') },
  };
  const DIM_LABELS = [tr('esplora'), tr('costruisce'), tr('verifica'), tr('novità'), tr('errori'), tr('ripete'), tr('contesto')];
  const DIM_HELP = [
    tr('quanto legge e cerca'), tr('quanto modifica'), tr('quanto lancia test e controlli'), tr('quante cose nuove incontra'),
    tr('quante azioni falliscono'), tr('quanto ripete le stesse azioni'), tr('quanto è pieno il suo contesto'),
  ];
  // assi della vista 3D: combinazioni leggibili delle 7 dimensioni
  const AXES = {
    work: { label: tr('esplora ← → costruisce'), f: v => (v[1] + v[2]) - v[0], min: -1, max: 1 },
    novelty: { label: tr('novità'), f: v => v[3], min: 0, max: 1 },
    friction: { label: tr('attrito (errori, ripetizioni)'), f: v => Math.max(v[4], v[5]), min: 0, max: 1 },
    context: { label: tr('contesto'), f: v => v[6], min: 0, max: 1 },
    explore: { label: tr('esplora'), f: v => v[0], min: 0, max: 1 },
    build: { label: tr('costruisce'), f: v => v[1], min: 0, max: 1 },
    verify: { label: tr('verifica'), f: v => v[2], min: 0, max: 1 },
    errors: { label: tr('errori'), f: v => v[4], min: 0, max: 1 },
    repeat: { label: tr('ripete'), f: v => v[5], min: 0, max: 1 },
  };
  const GROUPS = { abs: tr('FUORI DAL PROGETTO'), web: tr('WEB'), cmd: tr('TERMINALE'), agent: tr('SQUADRA'), tool: tr('STRUMENTI') };
  const AGENT_COLS = ['#FFEC27', '#29ADFF', '#FF77A8', '#00E436', '#FFA300', '#83769C', '#FFCCAA', '#FF004D'];

  const W = { open: false, sid: null, aid: 'main', replay: false, data: null, T: null, playing: false, yaw: -0.6, pitch: 0.42, drag: null,
    axes: ['work', 'novelty', 'friction'], hover: null, tiles: [], timer: null, fetching: false, layoutSig: '', layout: null, lastFrame: 0,
    view: 'map', mind: null, mhover: null, ground: null, groundSeq: 0, zoom: {} };
  const VIEWS = ['map', 'mind', 'ground', 'surp'];
  const usesGround = () => W.view === 'ground' || W.view === 'surp'; // le due viste leggono /api/grounding

  function el() { return $('#worldmap'); }

  window.openWorldMap = function (sid, aid, replay) {
    W.open = true; W.sid = sid; W.aid = aid || 'main'; W.replay = !!replay; W.T = null; W.playing = false; W.data = null; W.mind = null; W.ground = null; W.layoutSig = ''; W.zoom = {};
    build();
    el().hidden = false;
    refresh();
    clearInterval(W.timer);
    W.timer = setInterval(() => { if (W.open && W.T == null) refresh(); }, 2000);
    requestAnimationFrame(loop);
  };
  window.closeWorldMap = function () { W.open = false; clearInterval(W.timer); const e = el(); if (e) e.hidden = true; };
  window.worldMapOpen = () => W.open;

  function sessionOf() { return window.getSession ? getSession(W.sid) : null; }

  function build() {
    const s = sessionOf();
    const agents = s ? [s.main, ...s.subs.filter(a => !a.finished || a.id === W.aid)] : [];
    const opts = [['all', tr('Tutta la sessione')], ...agents.map(a => [a.id, window.agentName ? agentName(a) : a.id])];
    const axSel = i => `<select data-ax="${i}">${Object.entries(AXES).map(([k, a]) => `<option value="${k}" ${W.axes[i] === k ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`;
    el().innerHTML = `
      <div class="wm-head">
        <h3>${esc(tr('MAPPA DELLA REALTÀ'))}</h3>
        <select class="wm-agent">${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === W.aid ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <span class="wm-views">${[['map', tr('TERRITORIO E TRAIETTORIA')], ['mind', tr('BOLLA E STELLA POLARE')], ['ground', tr('MAPPA E TERRITORIO')], ['surp', tr('SORPRESA E CAUSE')]].map(([v, l]) => `<button data-v="${v}" title="${esc(l)}">${esc(l)}</button>`).join('')}</span>
        <span class="wm-phase"></span>
        <span class="wm-stats"></span>
        <button class="wm-help-btn" title="${esc(tr('Come si legge'))}">?</button>
        <span class="x" title="${esc(tr('Chiudi'))}">X</span>
      </div>
      <div class="wm-body">
        <div class="wm-terr"><div class="wm-cap">${esc(tr('TERRITORIO'))} <span class="dim">${esc(tr('che cosa conosce'))}</span></div><canvas></canvas><div class="wm-tip" hidden></div></div>
        <div class="wm-side">
          <div class="wm-traj"><div class="wm-cap">${esc(tr('TRAIETTORIA'))} <span class="dim">${esc(tr('come sta lavorando'))}</span></div><canvas></canvas>
            <div class="wm-axes">X ${axSel(0)} Y ${axSel(1)} Z ${axSel(2)}</div></div>
          <div class="wm-radar"><div class="wm-cap">${esc(tr('ADESSO'))} <span class="dim">${esc(tr('le 7 dimensioni'))}</span></div><canvas></canvas></div>
        </div>
      </div>
      <div class="wm-body wm-mind">
        <div class="wm-bub"><div class="wm-cap">${esc(tr('BOLLA DEL CONTESTO'))} <span class="dim">${esc(tr('che cosa ha in testa'))}</span> <span class="wm-exp">${esc(tr('SPERIMENTALE'))}</span></div><canvas></canvas><div class="wm-tip" hidden></div></div>
        <div class="wm-side">
          <div class="wm-star"><div class="wm-cap">${esc(tr('STELLA POLARE'))} <span class="dim">${esc(tr('quanto resta sul compito'))}</span></div><canvas></canvas><div class="wm-starinfo"></div></div>
          <div class="wm-comp"><div class="wm-cap">${esc(tr('DI COSA È FATTO IL CONTESTO'))}</div><div class="wm-compbody"></div></div>
        </div>
      </div>
      <div class="wm-body wm-ground">
        <div class="wm-gterr"><div class="wm-cap">${esc(tr('TERRITORIO'))} <span class="dim">${esc(tr('con i fantasmi e i ricordi scaduti'))}</span></div><canvas></canvas><div class="wm-tip" hidden></div></div>
        <div class="wm-gside"><div class="wm-cap">${esc(tr('MAPPA CONTRO TERRITORIO'))} <span class="dim">${esc(tr('quello che dice e sa, contro quello che c\'è'))}</span></div><div class="wm-gbody"></div></div>
      </div>
      <div class="wm-body wm-surp">
        <div class="wm-seis"><div class="wm-cap">${esc(tr('SISMOGRAFO'))} <span class="dim">${esc(tr('le smentite del mondo, alte quanto la sorpresa'))}</span></div><canvas></canvas><div class="wm-tip" hidden></div></div>
        <div class="wm-gside"><div class="wm-cap">${esc(tr('CAUSE'))} <span class="dim">${esc(tr('errore → file citato → modifica → conferma'))}</span></div><div class="wm-gbody wm-sbody"></div></div>
      </div>
      <div class="wm-time"><button class="wm-play">▶</button><canvas class="wm-band"></canvas><input type="range" min="0" max="1000" value="1000"><button class="wm-live">${esc(tr('IN DIRETTA'))}</button><span class="wm-clock"></span></div>
      <div class="wm-legend" hidden>
        <p><b>${esc(tr('Territorio'))}</b>: ${esc(tr('ogni quadratino è un file o un luogo che l\'agente può incontrare. La nebbia è ciò che non ha mai visto; blu scuro: l\'ha visto citato ma non l\'ha aperto (la frontiera); azzurro: l\'ha letto, più chiaro se ci è tornato spesso; giallo: l\'ha modificato; verde: l\'ha creato. La scia bianca unisce gli ultimi posti visitati, il quadrato che lampeggia è dove si trova adesso.'))}</p>
        <p><b>${esc(tr('Traiettoria'))}</b>: ${esc(tr('ogni punto è un\'azione, colorato secondo la fase di lavoro. Dove sta il punto dice come lavora in quel momento: con gli assi di base, a sinistra esplora e a destra costruisce, in alto incontra cose nuove, in profondità c\'è attrito. Una scia che si stringe vuol dire che sta convergendo, un groviglio fitto che gira in tondo. Trascina per ruotare.'))}</p>
        <p><b>${esc(tr('Le 7 dimensioni'))}</b>: ${DIM_LABELS.map((l, i) => `<i>${esc(l)}</i> ${esc(DIM_HELP[i])}`).join(' · ')}. ${esc(tr('Sono calcolate sulle ultime 8 azioni.'))}</p>
        <p><b>${esc(tr('Bolla del contesto'))}</b>: ${esc(tr('ogni punto è un pezzo di quello che l\'agente ha davanti: il compito, i file letti, i risultati dei comandi e delle ricerche, le sue risposte. Pezzi che parlano delle stesse cose stanno vicini. Più il punto è grande, più token occupa. La bolla si gonfia man mano che il contesto si riempie (verde, poi giallo, poi rosso); quando Claude lo compatta, la bolla si sgonfia e i pezzi dimenticati escono fuori come polvere grigia, mentre il riassunto resta dentro.'))}</p>
        <p><b>${esc(tr('Stella polare'))}</b>: ${esc(tr('la stella è il compito che gli è stato dato. Il grafico dice quanto ogni azione parla delle stesse cose del compito, rispetto alle sue prime azioni: se resta bassa a lungo l\'agente sta andando alla deriva. Una nuova richiesta sposta la stella.'))}</p>
        <p><b>${esc(tr('Mappa e territorio'))}</b>: ${esc(tr('confronta quello che l\'agente sa e dice con quello che c\'è davvero. Contorno arancione con l\'orologio: un file che ha letto ed è poi cambiato (da un altro agente o fuori dalla sessione) senza che lui lo rileggesse, un ricordo scaduto. Caselle viola tratteggiate con il punto di domanda: file che ha cercato, aperto o citato e che non esistono, i percorsi inventati; più chiare se poi qualcuno li ha creati (era un\'intenzione). A destra, le sue affermazioni («i test passano», «ho corretto X»…) confrontate con quello che ha fatto nello stesso turno: ancorata se c\'è un fatto che la prova, senza prove se non c\'è, smentita se l\'ultimo esito è un fallimento. L\'indice di ancoraggio è la quota di affermazioni ancorate. Clic su una voce per andare a quel momento.'))}</p>
        <p><b>${esc(tr('Sorpresa e cause'))}</b>: ${esc(tr('ogni punta del sismografo è un fallimento (un test rosso, un comando che non va, un file che non c\'è…), alta quanto era inatteso: di più se prima funzionava, di meno se era il primo tentativo o un test appena scritto. Il colore dice cosa ha fatto dopo: verde si corregge, rosso insiste con lo stesso comando, grigio si ferma. A destra le catene: l\'errore, i file che cita, la prima modifica (verde se tocca un file citato, arancione se cerca altrove) e la conferma, quando lo stesso comando torna a riuscire. In ufficio, «!?» sopra la testa per una sorpresa forte e una nuvoletta grigia per chi insiste.'))}</p>
        <p><b>${esc(tr('Zoom'))}</b>: ${esc(tr('rotella per ingrandire attorno al cursore, trascina per spostarti (nei grafici 3D con Maiusc o con il tasto destro, perché il trascinamento li ruota), doppio clic o il tasto «1:1» per tornare alla vista intera. Il territorio ingrandito mostra i nomi dei file; il sismografo ingrandisce solo il tempo.'))}</p>
        <p class="dim">${esc(tr('Motore lessicale sperimentale: confronta le parole importanti (anche dentro i nomi dei file e del codice), non il significato profondo. Funziona tutto sul computer, senza scaricare modelli.'))}</p>
        <p class="dim">${esc(tr('La mappa è ricostruita da quello che l\'agente fa (file, comandi, ricerche, esiti), non da quello che pensa: i suoi pensieri non sono visibili.'))}</p>
      </div>`;
    const e = el();
    e.querySelector('.x').onclick = closeWorldMap;
    e.querySelector('.wm-help-btn').onclick = () => { const l = e.querySelector('.wm-legend'); l.hidden = !l.hidden; };
    e.querySelector('.wm-agent').onchange = ev => { W.aid = ev.target.value; W.data = null; W.mind = null; W.T = null; W.layoutSig = ''; for (const k in ZBOX) if (W.zoom[k]) setZoom(k, { k: 1, x: 0, y: 0 }, 0, 0); refresh(); };
    for (const s of e.querySelectorAll('select[data-ax]')) s.onchange = ev => { W.axes[Number(ev.target.dataset.ax)] = ev.target.value; };
    const range = e.querySelector('input[type=range]');
    range.oninput = () => { W.playing = false; const [a, b] = span(); W.T = Number(range.value) >= 1000 ? null : a + (b - a) * Number(range.value) / 1000; };
    e.querySelector('.wm-live').onclick = () => { W.T = null; W.playing = false; refresh(); };
    e.querySelector('.wm-play').onclick = () => { if (W.playing) { W.playing = false; return; } const [a] = span(); W.T = a; W.playing = true; };
    const traj = e.querySelector('.wm-traj canvas');
    traj.onpointerdown = ev => { if (panGesture(ev)) return; W.drag = { x: ev.clientX, y: ev.clientY, yaw: W.yaw, pitch: W.pitch }; traj.setPointerCapture(ev.pointerId); };
    traj.onpointermove = ev => { if (!W.drag) return; W.yaw = W.drag.yaw + (ev.clientX - W.drag.x) / 120; W.pitch = Math.max(-1.3, Math.min(1.3, W.drag.pitch + (ev.clientY - W.drag.y) / 160)); };
    traj.onpointerup = () => { W.drag = null; };
    for (const b of e.querySelectorAll('.wm-views button')) b.onclick = () => setView(b.dataset.v);
    setView(W.view);
    const bub = e.querySelector('.wm-bub canvas');
    bub.onpointerdown = ev => { if (panGesture(ev)) return; W.drag = { x: ev.clientX, y: ev.clientY, yaw: W.yaw, pitch: W.pitch }; bub.setPointerCapture(ev.pointerId); };
    bub.onpointermove = ev => {
      const r = bub.getBoundingClientRect(); W.mhover = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      if (!W.drag) return; W.yaw = W.drag.yaw + (ev.clientX - W.drag.x) / 120; W.pitch = Math.max(-1.3, Math.min(1.3, W.drag.pitch + (ev.clientY - W.drag.y) / 160));
    };
    bub.onpointerup = () => { W.drag = null; };
    bub.onmouseleave = () => { W.mhover = null; };
    for (const terr of e.querySelectorAll('.wm-terr canvas, .wm-gterr canvas')) {
      terr.onmousemove = ev => { const r = terr.getBoundingClientRect(); W.hover = { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      terr.onmouseleave = () => { W.hover = null; };
    }
    // un elemento dell'elenco porta al suo momento sulla linea del tempo
    for (const gb of e.querySelectorAll('.wm-gbody')) gb.onclick = ev => {
      const it = ev.target.closest('[data-t]');
      if (!it) return;
      W.playing = false; W.T = Number(it.dataset.t);
    };
    const seis = e.querySelector('.wm-seis canvas');
    seis.onmousemove = ev => { const r = seis.getBoundingClientRect(); W.shover = { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    seis.onmouseleave = () => { W.shover = null; };
    seis.onclick = () => { const sp = W.spikeHover; if (sp && !justPanned(seis)) { W.playing = false; W.T = sp.t; } };
    zoomable('terr'); zoomable('gterr'); zoomable('seis', { axis: 'x' });
    zoomable('traj', { pan: panGesture }); zoomable('bub', { pan: panGesture });
  }

  function setView(v) {
    W.view = VIEWS.includes(v) ? v : 'map';
    const e = el();
    e.classList.toggle('view-mind', W.view === 'mind');
    e.classList.toggle('view-ground', W.view === 'ground');
    e.classList.toggle('view-surp', W.view === 'surp');
    for (const b of e.querySelectorAll('.wm-views button')) b.classList.toggle('on', b.dataset.v === W.view);
    W.layoutSig = '';
    if ((W.view === 'mind' && !W.mind) || (usesGround() && !W.ground)) refresh();
  }
  async function refresh() {
    if (W.fetching) return;
    W.fetching = true;
    try {
      const q = new URLSearchParams({ sid: W.sid, aid: W.aid });
      if (W.replay) q.set('replay', '1');
      const r = await fetch('/api/agentmap?' + q);
      const d = await r.json();
      if (d && d.ok) W.data = d;
      if (W.view === 'mind') {
        const m = await (await fetch('/api/agentmind?' + q)).json();
        if (m && m.ok) W.mind = m;
      }
      if (usesGround()) {
        const g = await (await fetch('/api/grounding?' + q)).json();
        if (g && g.ok) { W.ground = g; W.groundSeq++; }
      }
    } catch {} finally { W.fetching = false; }
  }

  function allSteps() {
    if (W.view === 'mind' && W.mind && W.mind.pieces) return W.mind.pieces;
    return W.data ? W.data.trajectories.flatMap(t => t.steps) : [];
  }
  function span() {
    const st = allSteps();
    if (!st.length) return [Date.now() - 60000, Date.now()];
    let a = Infinity, b = -Infinity;
    for (const s of st) { if (s[0] < a) a = s[0]; if (s[0] > b) b = s[0]; }
    return [a, Math.max(b, a + 1000)];
  }
  const nowT = () => (W.T == null ? Infinity : W.T);

  // ---------------------------------------------------------------- territorio (treemap con la nebbia)
  function groupOf(key) { const m = /^(abs|web|cmd|agent|tool):/.exec(key); return m ? m[1] : null; }
  function buildHierarchy() {
    const d = W.data;
    const root = { name: '', kids: new Map(), files: [], w: 0 };
    const known = new Map(d.nodes.map(n => [n[0], n]));
    const keys = new Set(d.tree && d.tree.available ? d.tree.files.map(f => f[0]) : []);
    for (const k of known.keys()) keys.add(k);
    // nella vista "mappa e territorio" anche i file citati nelle risposte che non esistono hanno una casella
    if (W.view === 'ground' && W.ground) for (const g of W.ground.ghosts) keys.add(g.key);
    for (const key of keys) {
      const g = groupOf(key);
      let parts;
      if (g === 'abs') { const p = key.slice(4).split('/').filter(Boolean); parts = [GROUPS.abs, ...p.slice(-3)]; }
      else if (g === 'web') { const rest = key.slice(4); const i = rest.indexOf('/'); parts = [GROUPS.web, i > 0 ? rest.slice(0, i) : rest, i > 0 ? rest.slice(i) : '/']; }
      else if (g) parts = [GROUPS[g], key.slice(g.length + 1) || '?'];
      else if (key === '.') continue;
      else parts = key.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.kids.has(parts[i])) node.kids.set(parts[i], { name: parts[i], kids: new Map(), files: [], w: 0, special: i === 0 && !!g });
        node = node.kids.get(parts[i]);
      }
      node.files.push({ key, name: parts[parts.length - 1], n: known.get(key) || null });
    }
    const weigh = n => { n.w = n.files.length; for (const k of n.kids.values()) n.w += weigh(k); return n.w || 1; };
    weigh(root);
    return root;
  }
  // treemap "squarified": rettangoli il più possibile quadrati
  function squarify(items, x, y, w, h, out) {
    items = items.filter(i => i.w > 0).sort((a, b) => b.w - a.w);
    const total = items.reduce((s, i) => s + i.w, 0);
    if (!items.length || w < 1 || h < 1) return;
    const scale = (w * h) / total;
    let row = [], rect = { x, y, w, h };
    const worst = (r, side) => { const s = r.reduce((a, i) => a + i.w * scale, 0); let mx = 0, mn = Infinity; for (const i of r) { mx = Math.max(mx, i.w * scale); mn = Math.min(mn, i.w * scale); } return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
    const place = r => {
      const s = r.reduce((a, i) => a + i.w * scale, 0);
      if (rect.w >= rect.h) { const cw = s / rect.h; let cy = rect.y; for (const i of r) { const ih = i.w * scale / cw; out.push([i, rect.x, cy, cw, ih]); cy += ih; } rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h }; }
      else { const ch = s / rect.w; let cx = rect.x; for (const i of r) { const iw = i.w * scale / ch; out.push([i, cx, rect.y, iw, ch]); cx += iw; } rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch }; }
    };
    for (const it of items) {
      const side = Math.min(rect.w, rect.h);
      if (!row.length || worst(row.concat(it), side) <= worst(row, side)) row.push(it);
      else { place(row); row = [it]; }
    }
    if (row.length) place(row);
  }
  function layoutTree(root, W0, H0) {
    const tiles = [], boxes = [];
    const rec = (node, x, y, w, h, depth) => {
      const items = [...[...node.kids.values()].map(k => ({ w: k.w, dir: k })), ...node.files.map(f => ({ w: 1, file: f }))];
      let ix = x, iy = y, iw = w, ih = h;
      if (depth > 0) {
        boxes.push({ name: node.name, x, y, w, h, depth, special: node.special });
        const lab = w > 40 && h > 26 ? 11 : 0;
        ix += 2; iy += 2 + lab; iw -= 4; ih -= 4 + lab;
      }
      const out = [];
      squarify(items, ix, iy, iw, ih, out);
      for (const [it, rx, ry, rw, rh] of out) {
        if (it.dir) rec(it.dir, rx, ry, rw, rh, depth + 1);
        else tiles.push({ ...it.file, x: rx, y: ry, w: rw, h: rh });
      }
    };
    rec(root, 0, 0, W0, H0, 0);
    return { tiles, boxes };
  }

  function levelAt(n, T) {
    if (!n) return 0;
    if (n[3] && n[3] <= T) return n[4] ? 4 : 3;
    if (n[2] && n[2] <= T) return 2;
    if (n[1] && n[1] <= T) return 1;
    return 0;
  }
  function fitCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ---------------------------------------------------------------- zoom dei grafici: rotella, trascina, doppio clic
  // per ogni grafico: schermo = disegno * k + (x, y). Il sismografo ingrandisce solo il tempo (asse x).
  const ZBOX = { terr: '.wm-terr', gterr: '.wm-gterr', traj: '.wm-traj', bub: '.wm-bub', seis: '.wm-seis' };
  const ZOOM_MAX = 8;
  const zoomOf = key => W.zoom[key] || { k: 1, x: 0, y: 0 };
  // nei grafici 3D il trascinamento ruota: si sposta con Maiusc o con il tasto destro
  const panGesture = ev => ev.shiftKey || ev.button === 1 || ev.button === 2;
  function setZoom(key, z, w, h, axis) {
    z.k = Math.max(1, Math.min(ZOOM_MAX, z.k));
    z.x = Math.min(0, Math.max(w * (1 - z.k), z.x));
    z.y = axis === 'x' ? 0 : Math.min(0, Math.max(h * (1 - z.k), z.y));
    if (z.k < 1.01) z.k = 1, z.x = 0, z.y = 0;
    W.zoom[key] = z;
    const chip = el().querySelector(ZBOX[key] + ' .wm-zoom');
    if (chip) { chip.hidden = z.k === 1; chip.textContent = '×' + z.k.toFixed(1) + ' · 1:1'; }
    const cv = el().querySelector(ZBOX[key] + ' canvas');
    if (cv && (key === 'terr' || key === 'gterr')) cv.style.cursor = z.k > 1 ? 'grab' : '';
  }
  function zoomable(key, { axis = 'xy', pan = () => true } = {}) {
    const box = el().querySelector(ZBOX[key]), cv = box.querySelector('canvas');
    const size = () => { const r = cv.getBoundingClientRect(); return [r, r.width, r.height]; };
    const reset = () => { const [, w, h] = size(); setZoom(key, { k: 1, x: 0, y: 0 }, w, h, axis); };
    const chip = document.createElement('button');
    chip.className = 'wm-zoom'; chip.hidden = true; chip.title = tr('Torna alla vista intera (doppio clic)');
    chip.onclick = reset;
    box.appendChild(chip);
    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const [r, w, h] = size(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const z0 = zoomOf(key), k = Math.max(1, Math.min(ZOOM_MAX, z0.k * Math.exp(-ev.deltaY * 0.0015)));
      // il punto sotto il cursore resta fermo
      setZoom(key, { k, x: mx - (mx - z0.x) * k / z0.k, y: axis === 'x' ? 0 : my - (my - z0.y) * k / z0.k }, w, h, axis);
    }, { passive: false });
    cv.addEventListener('dblclick', reset);
    cv.addEventListener('contextmenu', ev => ev.preventDefault());
    let p = null;
    cv.addEventListener('pointerdown', ev => {
      if (zoomOf(key).k === 1 || !pan(ev)) return;
      p = { x: ev.clientX, y: ev.clientY, z: { ...zoomOf(key) }, moved: false };
      cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', ev => {
      if (!p) return;
      const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
      const [, w, h] = size();
      setZoom(key, { k: p.z.k, x: p.z.x + dx, y: p.z.y + dy }, w, h, axis);
    });
    const end = () => { if (p && p.moved) cv._panned = Date.now(); p = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
  const justPanned = cv => Date.now() - (cv._panned || 0) < 250; // il clic che chiude un trascinamento non conta

  function drawTerritory(t, box = '.wm-terr') {
    const cv = el().querySelector(box + ' canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#07060c'; ctx.fillRect(0, 0, w, h);
    const d = W.data;
    if (!d) { ctx.fillStyle = '#83769C'; ctx.font = '18px VT, monospace'; ctx.fillText(tr('Carico la mappa…'), 12, 24); return; }
    const g = box === '.wm-gterr' ? W.ground : null;
    const sig = w + 'x' + h + '|' + d.nodes.length + '|' + (d.tree ? d.tree.files.length : 0) + '|' + W.aid + '|' + (g ? g.ghosts.length : -1);
    if (sig !== W.layoutSig) { W.layout = layoutTree(buildHierarchy(), w, h); W.layoutSig = sig; }
    // con lo zoom le caselle si ridisegnano più grandi (non la stessa immagine ingrandita): i nomi compaiono man mano
    const zkey = box === '.wm-gterr' ? 'gterr' : 'terr', z = zoomOf(zkey);
    const zsig = sig + '|' + z.k + '|' + z.x + '|' + z.y;
    if (W.layout.zsig !== zsig) {
      const sc = r => ({ ...r, x: r.x * z.k + z.x, y: r.y * z.k + z.y, w: r.w * z.k, h: r.h * z.k });
      const inView = r => r.x < w && r.y < h && r.x + r.w > 0 && r.y + r.h > 0;
      const all = W.layout.tiles.map(sc);
      // la scia usa tutte le caselle (anche fuori dallo schermo), il disegno solo quelle visibili
      W.layout.z = { all, tiles: z.k === 1 ? all : all.filter(inView), boxes: W.layout.boxes.map(sc).filter(inView) };
      W.layout.zsig = zsig;
    }
    const { all, tiles, boxes } = W.layout.z;
    const T = nowT();
    const fogPat = fogPattern(ctx);
    const byKey = new Map();
    let total = 0, known = 0, frontier = 0, edited = 0;
    for (const tl of all) {
      byKey.set(tl.key, tl);
      if (groupOf(tl.key)) continue;
      const lv = levelAt(tl.n, T);
      total++; if (lv >= 2) known++; if (lv === 1) frontier++; if (lv >= 3) edited++;
    }
    for (const tl of tiles) {
      const lv = levelAt(tl.n, T);
      const x = tl.x + 0.5, y = tl.y + 0.5, ww = Math.max(0.5, tl.w - 1), hh = Math.max(0.5, tl.h - 1);
      if (lv === 0) { ctx.fillStyle = fogPat; ctx.fillRect(x, y, ww, hh); continue; }
      let col;
      if (lv === 1) col = '#1d2b53';
      else if (lv === 2) { const k = Math.min(1, (tl.n[5] || 1) / 6); col = mix('#1f5f9e', '#9fd8ff', k); }
      else if (lv === 3) col = '#ffec27';
      else col = '#00e436';
      ctx.fillStyle = col; ctx.fillRect(x, y, ww, hh);
      // appena toccato: bordo bianco che pulsa
      const last = tl.n[6] || 0;
      if (W.T == null && last && Date.now() - last < 15000 && ((t / 250) | 0) % 2) { ctx.strokeStyle = '#fff1e8'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1); }
      // il nome resta dentro la parte visibile della casella (ingrandita può uscire dal bordo)
      const lx = Math.max(x, 0), ly = Math.max(y, 0), lw = Math.min(x + ww, w) - lx;
      if (lw > 46 && y + hh - ly > 12) { ctx.fillStyle = lv >= 3 ? '#000' : lv === 1 ? '#83769C' : '#07060c'; ctx.font = '13px VT, monospace'; ctx.fillText(clipText(ctx, tl.name, lw - 4), lx + 2, ly + 11); }
    }
    for (const b of boxes) {
      ctx.strokeStyle = b.special ? '#7e2553' : b.depth === 1 ? '#5f574f' : '#2a2440';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      if (b.w > 40 && b.h > 26 && b.y >= 0) { ctx.fillStyle = b.special ? '#ff77a8' : '#c2c3c7'; ctx.font = '13px VT, monospace'; const bx = Math.max(b.x, 0); ctx.fillText(clipText(ctx, b.name + '/', Math.min(b.x + b.w, w) - bx - 6), bx + 3, b.y + 10); }
    }
    // la scia degli ultimi posti visitati e la posizione attuale
    const traj = d.trajectories;
    traj.forEach((tj, ai) => {
      const pts = tj.steps.filter(s => s[0] <= T && s[3] && byKey.has(s[3])).slice(-30).map(s => byKey.get(s[3]));
      const col = traj.length > 1 ? AGENT_COLS[ai % AGENT_COLS.length] : '#fff1e8';
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        ctx.globalAlpha = 0.15 + 0.7 * (i / pts.length);
        ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2); ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const cur = pts[pts.length - 1];
      if (cur && ((t / 300) | 0) % 2) { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(cur.x - 1, cur.y - 1, cur.w + 2, cur.h + 2); }
    });
    // mappa contro territorio: fantasmi (viola, tratteggiati, "?") e ricordi scaduti (arancione, orologio)
    const ghostAt = new Map(), staleAt = new Map();
    if (g) {
      for (const x of g.ghosts) if (x.t <= T && !ghostAt.has(x.key)) ghostAt.set(x.key, x);
      for (const x of g.stale) if ((x.changedAt || x.readAt) <= T && !staleAt.has(x.key)) staleAt.set(x.key, x);
      ctx.save();
      for (const [key, x] of ghostAt) {
        const tl = byKey.get(key); if (!tl) continue;
        ctx.fillStyle = x.createdLater ? 'rgba(131,118,156,0.35)' : 'rgba(126,37,83,0.75)';
        ctx.fillRect(tl.x + 0.5, tl.y + 0.5, Math.max(0.5, tl.w - 1), Math.max(0.5, tl.h - 1));
        ctx.setLineDash([3, 2]); ctx.strokeStyle = '#ff77a8'; ctx.lineWidth = 1.5;
        ctx.strokeRect(tl.x + 1, tl.y + 1, Math.max(1, tl.w - 2), Math.max(1, tl.h - 2));
        ctx.setLineDash([]);
        if (tl.w > 9 && tl.h > 9) { ctx.fillStyle = '#ff77a8'; ctx.font = '14px VT, monospace'; ctx.fillText('?', tl.x + tl.w - 8, tl.y + tl.h - 3); }
      }
      for (const [key] of staleAt) {
        const tl = byKey.get(key); if (!tl) continue;
        ctx.strokeStyle = '#ffa300'; ctx.lineWidth = 2;
        ctx.strokeRect(tl.x + 1, tl.y + 1, Math.max(1, tl.w - 2), Math.max(1, tl.h - 2));
        if (tl.w > 10 && tl.h > 10) drawClock(ctx, tl.x + tl.w - 6, tl.y + 6, 4);
      }
      ctx.restore();
    }
    // tooltip
    const tip = el().querySelector(box + ' .wm-tip');
    let ht = null;
    if (W.hover) for (const tl of tiles) if (W.hover.x >= tl.x && W.hover.x < tl.x + tl.w && W.hover.y >= tl.y && W.hover.y < tl.y + tl.h) { ht = tl; break; }
    if (ht) {
      const n = ht.n, lv = levelAt(n, T);
      const what = [tr('mai visto (nebbia)'), tr('visto citato, non aperto'), trn('letto {n} volta', 'letto {n} volte', (n && n[5]) || 1), tr('modificato'), tr('creato')][lv];
      const when = n ? [n[1] && tr('visto alle {t}', { t: hhmm(n[1]) }), n[2] && tr('letto alle {t}', { t: hhmm(n[2]) }), n[3] && tr('modificato alle {t}', { t: hhmm(n[3]) })].filter(Boolean).join(' · ') : '';
      const gh = ghostAt.get(ht.key), st = staleAt.get(ht.key);
      const whose = x => (W.aid === 'all' ? x.agentName + ': ' : '');
      const extra = (gh ? '<br><span class="gh">' + esc(whose(gh) + ghostText(gh)) + '</span>' : '') + (st ? '<br><span class="st">' + esc(whose(st) + staleText(st)) + '</span>' : '');
      const html = `<b>${esc(ht.key.replace(/^(abs|web|cmd|agent|tool):/, ''))}</b><br>${esc(gh && lv === 0 ? tr('non esiste') : what)}${when ? '<br><span class="dim">' + esc(when) + '</span>' : ''}${extra}`;
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      tip.hidden = false;
      tip.style.left = Math.min(w - 220, W.hover.x + 12) + 'px';
      tip.style.top = Math.min(h - 50, W.hover.y + 12) + 'px';
    } else tip.hidden = true;
    const stats = el().querySelector('.wm-stats');
    const txt = d.tree && d.tree.available && total
      ? tr('{p}% del progetto conosciuto · {f} file sulla frontiera · {e} modificati', { p: Math.round(100 * known / total), f: frontier, e: edited })
      : tr('Progetto non leggibile da qui: si vede solo ciò che l\'agente ha toccato');
    if (stats._t !== txt) { stats.textContent = txt; stats._t = txt; }
  }
  const hhmm = x => new Date(x).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  function drawClock(ctx, x, y, r) {
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffa300'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - r + 1); ctx.moveTo(x, y); ctx.lineTo(x + r - 1.5, y); ctx.stroke();
  }

  // ---------------------------------------------------------------- mappa contro territorio: testi e pannello
  const GHOST_SRC = { tool: tr('aperto con uno strumento'), output: tr('cercato da un comando'), reply: tr('citato in una risposta') };
  const CLAIM_KIND = { tests: tr('test'), verified: tr('verificato'), fixed: tr('corretto'), created: tr('creato'), done: tr('fatto') };
  const CLAIM_STATUS = { grounded: [tr('ANCORATA'), 'ok'], ungrounded: [tr('SENZA PROVE'), 'mid'], contradicted: [tr('SMENTITA'), 'bad'] };
  function ghostText(x) {
    const s = tr('non esiste: {how} alle {t}', { how: GHOST_SRC[x.source] || x.source, t: hhmm(x.t) });
    return x.createdLater ? s + ' · ' + tr('poi creato: era un\'intenzione') : s;
  }
  function staleText(x) {
    if (x.gone) return tr('letto alle {a}, poi cancellato', { a: hhmm(x.readAt) });
    if (x.changedBy) return tr('letto alle {a}, cambiato alle {b} da {who}', { a: hhmm(x.readAt), b: hhmm(x.changedAt), who: x.changedBy });
    return tr('letto alle {a}, cambiato alle {b} fuori dalla sessione (da te o da un altro programma)', { a: hhmm(x.readAt), b: hhmm(x.changedAt || x.mtime) });
  }
  function evidenceText(c) {
    const e = c.evidence;
    if (!e) return c.kind === 'done' ? tr('nessuna prova richiesta') : tr('nel turno non c\'è un fatto che la confermi');
    const what = e.target ? e.target.replace(/^(cmd|abs|web|agent|tool):/, '') : e.tool;
    return (e.err ? tr('ultimo esito: {what} fallito alle {t}', { what, t: hhmm(e.t) }) : tr('prova: {what} alle {t}', { what, t: hhmm(e.t) }));
  }
  function drawGroundPanel() {
    const box = el().querySelector('.wm-gbody');
    const g = W.ground, T = nowT();
    const key = W.groundSeq + '|' + (W.T == null ? 'live' : Math.floor(W.T / 1000));
    if (box._k === key) return;
    box._k = key;
    if (!g) { box.innerHTML = `<p class="dim">${esc(tr('Carico la mappa…'))}</p>`; return; }
    const many = W.aid === 'all';
    const who = x => (many ? `<span class="ag">${esc(x.agentName)}</span> ` : '');
    const at = (arr, f) => arr.filter(x => f(x) <= T);
    const claims = at(g.claims, x => x.t), stale = at(g.stale, x => x.changedAt || x.readAt), ghosts = at(g.ghosts, x => x.t), blind = at(g.blindEdits, x => x.t);
    const gr = claims.filter(c => c.status === 'grounded').length;
    const pct = claims.length ? Math.round(100 * gr / claims.length) : null;
    const sec = (title, n, body) => `<div class="gs"><div class="gt">${esc(title)} <span class="n">${n}</span></div>${body || `<div class="dim">${esc(tr('nessuno'))}</div>`}</div>`;
    const row = (t, html) => `<div class="gi" data-t="${t}" title="${esc(tr('Vai a questo momento'))}">${html}</div>`;
    let html = `<div class="gscore"><b class="${pct == null ? '' : pct >= 70 ? 'ok' : pct >= 40 ? 'mid' : 'bad'}">${pct == null ? '—' : pct + '%'}</b>` +
      `<span>${esc(tr('INDICE DI ANCORAGGIO'))}<br><span class="dim">${claims.length ? esc(trn('{g} affermazione ancorata su {n}', '{g} affermazioni ancorate su {n}', claims.length, { g: gr })) : esc(tr('nessuna affermazione da controllare'))}</span></span></div>`;
    html += sec(tr('AFFERMAZIONI'), claims.length, claims.slice(0, 60).map(c => {
      const [lab, cls] = CLAIM_STATUS[c.status] || CLAIM_STATUS.ungrounded;
      return row(c.t, `<b class="${cls}">${esc(lab)}</b> ${who(c)}<span class="q">«${esc(c.text)}»</span><br><span class="dim">${esc(hhmm(c.t))} · ${esc(CLAIM_KIND[c.kind] || c.kind)} · ${esc(evidenceText(c))}</span>`);
    }).join(''));
    html += sec(tr('RICORDI SCADUTI'), stale.length, stale.slice(0, 60).map(x => row(x.changedAt || x.readAt, `<span class="clk">◷</span> ${who(x)}<span class="k">${esc(x.key)}</span><br><span class="dim">${esc(staleText(x))}</span>`)).join(''));
    html += sec(tr('PERCORSI INVENTATI'), ghosts.length, ghosts.slice(0, 60).map(x => row(x.t, `<span class="gq">?</span> ${who(x)}<span class="k">${esc(x.key)}</span>${x.createdLater ? ` <b class="later">${esc(tr('POI CREATO'))}</b>` : ''}<br><span class="dim">${esc(ghostText(x))}${x.excerpt ? ' · «' + esc(x.excerpt) + '»' : ''}</span>`)).join(''));
    if (blind.length) html += sec(tr('MODIFICHE ALLA CIECA'), blind.length, blind.slice(0, 30).map(x => row(x.t, `<b class="${x.caught ? 'mid' : 'bad'}">${esc(x.caught ? tr('FERMATA') : tr('ALLA CIECA'))}</b> ${who(x)}<span class="k">${esc(x.key)}</span><br><span class="dim">${esc(x.caught ? tr('Claude Code l\'ha fermata: il file era cambiato dopo l\'ultima lettura') : tr('modificato senza rileggerlo dopo la modifica di {who}', { who: x.changedBy || '?' }))}</span>`)).join(''));
    html += `<p class="dim note">${esc(tr('Ricostruito da quello che l\'agente fa e dice, non da quello che pensa. «Senza prove» vuol dire che nel turno non c\'è un fatto che la confermi, non che sia falsa.'))}` +
      (g.disk && !g.disk.checked && g.disk.reason ? ' ' + esc(tr('Disco non controllato: {why}.', { why: g.disk.reason })) : '') + '</p>';
    box.innerHTML = html;
  }

  // ---------------------------------------------------------------- sorpresa e cause: sismografo e catene
  const REACT = { corrects: [tr('SI CORREGGE'), '#00e436', 'ok'], insists: [tr('INSISTE'), '#ff004d', 'bad'], stops: [tr('SI FERMA'), '#83769c', ''], undecided: [tr('IN CORSO'), '#fff1e8', ''] };
  const CAUSE = { follows: [tr('SEGUE LA TRACCIA'), 'ok'], elsewhere: [tr('CERCA ALTROVE'), 'bad'], thinking: [tr('CI PENSA ANCORA'), 'mid'], notrail: [tr('NESSUNA TRACCIA'), ''], undecided: [tr('IN CORSO'), ''] };
  const FAIL_KIND = { test: tr('test fallito'), command: tr('comando fallito'), missing: tr('file inesistente'), permission: tr('permesso negato'), timeout: tr('tempo scaduto'), edit: tr('modifica senza la stringa da sostituire'), syntax: tr('errore di sintassi o di compilazione') };
  const WHY = { usedToWork: tr('prima funzionava'), firstTry: tr('primo tentativo'), tdd: tr('test appena scritto: è normale che fallisca') };
  const what = s => s.excerpt || String(s.target || '').replace(/^(cmd|abs|tool|web|agent):/, '');
  const whyText = s => s.reasons.filter(r => WHY[r]).map(r => WHY[r]).join(' · ');
  function drawSeismo(t) {
    const cv = el().querySelector('.wm-seis canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#07060c'; ctx.fillRect(0, 0, w, h);
    const g = W.ground;
    ctx.font = '15px VT, monospace';
    if (!g) { ctx.fillStyle = '#83769C'; ctx.fillText(tr('Carico la mappa…'), 12, 24); return; }
    const T = nowT();
    const list = g.surprises.filter(s => s.t <= T);
    const [a, b] = span();
    const many = W.aid === 'all';
    const rows = many ? [...new Map(g.surprises.map(s => [s.agent, s.agentName])).entries()].slice(0, 10) : [[W.aid, '']];
    const pad = many ? 92 : 10;
    const z = zoomOf('seis');
    const x = tt => (pad + ((tt - a) / (b - a)) * (w - pad - 10)) * z.k + z.x;
    W.spikes = [];
    if (!g.surprises.length) { ctx.fillStyle = '#83769C'; ctx.fillText(tr('Nessuna sorpresa: finora il mondo non gli ha dato torto.'), 12, 28); W.spikeHover = null; return; }
    const rowH = (h - 10) / rows.length;
    rows.forEach(([id, name], ri) => {
      const base = 6 + (ri + 1) * rowH - 4;
      ctx.strokeStyle = '#2a2440'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, base + 0.5); ctx.lineTo(w - 6, base + 0.5); ctx.stroke();
      // soglia della sorpresa forte (0,7)
      ctx.setLineDash([2, 4]); ctx.strokeStyle = '#3a2f4f'; ctx.beginPath(); ctx.moveTo(pad, base - 0.7 * (rowH - 12) + 0.5); ctx.lineTo(w - 6, base - 0.7 * (rowH - 12) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      if (many) { ctx.fillStyle = '#c2c3c7'; ctx.fillText(clipText(ctx, name, pad - 8), 4, base - 2); }
      // ingrandito, le punte non invadono la colonna dei nomi
      ctx.save(); ctx.beginPath(); ctx.rect(pad - 4, 0, w - pad + 4, h); ctx.clip();
      for (const s of list) {
        if (many && s.agent !== id) continue;
        const sx = x(s.t), hh = Math.max(3, s.value * (rowH - 12));
        if (sx < pad - 4 || sx > w + 4) continue;
        const col = (REACT[s.reaction] || REACT.stops)[1];
        // la più recente, se forte, trema un po'
        const live = W.T == null && Date.now() - s.t < 20000 && s.value >= 0.7;
        const jx = live ? Math.sin(t / 40) * 1.5 : 0;
        ctx.fillStyle = col; ctx.fillRect(sx - 1 + jx, base - hh, 3, hh);
        ctx.fillRect(sx - 3 + jx, base - hh - 2, 7, 3);
        W.spikes.push({ x: sx, y0: base - hh - 3, y1: base, s });
      }
      ctx.restore();
    });
    ctx.fillStyle = '#fff1e8';
    if (W.T != null) ctx.fillRect(x(W.T) - 1, 0, 2, h);
    // ingrandito: l'intervallo di tempo che si vede
    if (z.k > 1) {
      const at = sx => a + (((sx - z.x) / z.k - pad) / (w - pad - 10)) * (b - a);
      const lab = hhmm(at(pad)) + ' – ' + hhmm(at(w - 10));
      ctx.fillStyle = '#83769C'; ctx.fillText(lab, w - 10 - ctx.measureText(lab).width, 16);
    }
    // tooltip della punta più vicina
    const tip = el().querySelector('.wm-seis .wm-tip');
    let best = null;
    if (W.shover) for (const sp of W.spikes) { const d = Math.abs(sp.x - W.shover.x); if (d < 6 && W.shover.y >= sp.y0 - 6 && W.shover.y <= sp.y1 + 2 && (!best || d < best.d)) best = { d, sp }; }
    W.spikeHover = best ? best.sp.s : null;
    if (best) {
      const s = best.sp.s, [rl] = REACT[s.reaction] || REACT.stops;
      const html = `<b>${esc(FAIL_KIND[s.kind] || s.kind)}</b> · ${esc(tr('sorpresa {p}%', { p: Math.round(s.value * 100) }))}${many ? ' · ' + esc(s.agentName) : ''}<br>${esc(what(s))}<br><span class="dim">${esc(hhmm(s.t))} · ${esc(rl)}${whyText(s) ? ' · ' + esc(whyText(s)) : ''}</span>`;
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      tip.hidden = false;
      tip.style.left = Math.min(w - 260, W.shover.x + 12) + 'px';
      tip.style.top = Math.min(h - 70, W.shover.y + 12) + 'px';
    } else tip.hidden = true;
  }
  function drawSurprisePanel() {
    const box = el().querySelector('.wm-sbody');
    const g = W.ground, T = nowT();
    const key = W.groundSeq + '|' + (W.T == null ? 'live' : Math.floor(W.T / 1000));
    if (box._k === key) return;
    box._k = key;
    if (!g) { box.innerHTML = `<p class="dim">${esc(tr('Carico la mappa…'))}</p>`; return; }
    const many = W.aid === 'all';
    const sum = k => g.reactions.reduce((n, r) => n + (r[k] || 0), 0);
    const ratio = (a, b) => (b ? `${a}/${b}` : '—');
    let html = `<div class="gscore sstats">${esc(tr('si corregge {a} · segue la traccia {b} · catene complete {c}', { a: ratio(sum('corrects'), sum('total')), b: ratio(sum('follows'), sum('judged')), c: ratio(sum('complete'), sum('chains')) }))}</div>`;
    const list = g.surprises.filter(s => s.t <= T).slice().reverse();
    const who = s => (many ? `<span class="ag">${esc(s.agentName)}</span> ` : '');
    const row = (t, inner) => `<div class="gi" data-t="${t}" title="${esc(tr('Vai a questo momento'))}">${inner}</div>`;
    const chains = list.filter(s => s.refs && s.refs.length).slice(0, 40);
    html += `<div class="gs"><div class="gt">${esc(tr('CATENE CAUSALI'))} <span class="n">${chains.length}</span></div>` + (chains.map(s => {
      const [cl, cc] = s.chain.complete ? [tr('COMPLETA'), 'ok'] : (CAUSE[s.cause] || CAUSE.undecided);
      const r0 = s.refs[0], fix = s.chain.fix;
      const boxH = (cls, txt, tt) => `<span class="cbx ${cls}" title="${esc(tt || txt)}">${esc(txt)}</span>`;
      return row(s.t, `<b class="${cc}">${esc(cl)}</b> ${who(s)}<span class="dim">${esc(hhmm(s.t))}</span><div class="chain">` +
        boxH('err', FAIL_KIND[s.kind] || s.kind, s.excerpt) + '<i>→</i>' +
        boxH('ref', r0.file.replace(/^abs:/, '') + ':' + r0.line + (s.refs.length > 1 ? ' +' + (s.refs.length - 1) : ''), s.refs.map(r => r.file + ':' + r.line).join('\n')) + '<i>→</i>' +
        boxH(fix ? (fix.cited ? 'ok' : 'bad') : 'off', fix ? (fix.target || '').replace(/^(abs|cmd):/, '') : tr('nessuna modifica')) + '<i>→</i>' +
        boxH(s.chain.confirm ? 'ok' : 'off', s.chain.confirm ? tr('di nuovo verde') : tr('non ancora')) + '</div>');
    }).join('') || `<div class="dim">${esc(tr('nessuna: gli errori non citano file del progetto'))}</div>`) + '</div>';
    const rest = list.filter(s => !(s.refs && s.refs.length)).slice(0, 30);
    html += `<div class="gs"><div class="gt">${esc(tr('ALTRE SORPRESE'))} <span class="n">${rest.length}</span></div>` + (rest.map(s => {
      const [rl, , rc] = REACT[s.reaction] || REACT.stops;
      return row(s.t, `<b class="${rc}">${esc(rl)}</b> ${who(s)}<span class="q">${esc(what(s))}</span><br><span class="dim">${esc(hhmm(s.t))} · ${esc(FAIL_KIND[s.kind] || s.kind)} · ${esc(tr('sorpresa {p}%', { p: Math.round(s.value * 100) }))}${whyText(s) ? ' · ' + esc(whyText(s)) : ''}${s.discarded ? ' · ' + esc(tr('cita solo librerie')) : ''}</span>`);
    }).join('') || `<div class="dim">${esc(tr('nessuno'))}</div>`) + '</div>';
    html += `<p class="dim note">${esc(tr('Ricostruito dagli esiti dei comandi e dalle modifiche che seguono. «Segue la traccia» vuol dire che ha modificato un file citato dall\'errore, non che abbia capito davvero la causa.'))}</p>`;
    box.innerHTML = html;
  }

  let fogCache = null;
  function fogPattern(ctx) {
    if (fogCache) return ctx.createPattern(fogCache, 'repeat');
    const c = document.createElement('canvas'); c.width = 4; c.height = 4;
    const g = c.getContext('2d');
    g.fillStyle = '#100e1a'; g.fillRect(0, 0, 4, 4);
    g.fillStyle = '#1b1828'; g.fillRect(0, 0, 1, 1); g.fillRect(2, 2, 1, 1);
    fogCache = c;
    return ctx.createPattern(c, 'repeat');
  }
  function clipText(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
    return s.slice(0, lo) + '…';
  }
  function mix(a, b, k) {
    const p = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
    const A = p(a), B = p(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------- traiettoria 3D
  function project(p, w, h) {
    // p in [-1,1]^3 → schermo, con rotazione e un po' di prospettiva
    const cy = Math.cos(W.yaw), sy = Math.sin(W.yaw), cp = Math.cos(W.pitch), sp = Math.sin(W.pitch);
    let x = p[0] * cy - p[2] * sy, z = p[0] * sy + p[2] * cy;
    let y = p[1] * cp - z * sp; z = p[1] * sp + z * cp;
    const f = 6 / (6 + z), s = Math.min(w, h) * 0.3, zm = W.pz || { k: 1, x: 0, y: 0 };
    return [(w / 2 + x * s * f) * zm.k + zm.x, (h / 2 - y * s * f) * zm.k + zm.y, z];
  }
  function axisVal(k, v) { const a = AXES[k]; return ((a.f(v) - a.min) / (a.max - a.min)) * 2 - 1; }
  function drawTrajectory(t) {
    const cv = el().querySelector('.wm-traj canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#020803'; ctx.fillRect(0, 0, w, h);
    W.pz = zoomOf('traj');
    if (!W.drag && W.pz.k === 1) W.yaw += 0.0025; // ingrandito non gira da solo: quello che guardi resta lì
    // cubo e pavimento a griglia (grafica vettoriale verde)
    const C = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,228,54,0.12)';
    for (let i = -1; i <= 1.001; i += 0.5) {
      line(ctx, project([i, -1, -1], w, h), project([i, -1, 1], w, h));
      line(ctx, project([-1, -1, i], w, h), project([1, -1, i], w, h));
    }
    ctx.strokeStyle = 'rgba(0,228,54,0.35)';
    for (const [a, b] of E) line(ctx, project(C[a], w, h), project(C[b], w, h));
    // etichette degli assi
    ctx.font = '13px VT, monospace'; ctx.fillStyle = '#00e436';
    const lab = (p, s) => { const q = project(p, w, h); ctx.fillText(s, q[0] + 3, q[1] - 3); };
    lab([1.05, -1, -1], 'X ' + AXES[W.axes[0]].label);
    lab([-1, 1.05, -1], 'Y ' + AXES[W.axes[1]].label);
    lab([-1, -1, 1.1], 'Z ' + AXES[W.axes[2]].label);
    const d = W.data;
    if (!d) return;
    const T = nowT();
    const multi = d.trajectories.length > 1;
    d.trajectories.forEach((tj, ai) => {
      const st = tj.steps.filter(s => s[0] <= T && s[5]);
      if (!st.length) return;
      const pts = st.map(s => ({ p: [axisVal(W.axes[0], s[5]), axisVal(W.axes[1], s[5]), axisVal(W.axes[2], s[5])], ph: s[6], err: s[4] === 1 }));
      const col0 = multi ? AGENT_COLS[ai % AGENT_COLS.length] : null;
      // ombra sul pavimento: aiuta a capire la profondità
      ctx.strokeStyle = 'rgba(0,228,54,0.18)';
      ctx.beginPath();
      pts.forEach((q, i) => { const s = project([q.p[0], -1, q.p[2]], w, h); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.stroke();
      for (let i = 1; i < pts.length; i++) {
        const a = project(pts[i - 1].p, w, h), b = project(pts[i].p, w, h);
        ctx.globalAlpha = 0.12 + 0.88 * Math.pow(i / pts.length, 1.5);
        ctx.strokeStyle = col0 || (PHASES[pts[i].ph] || PHASES.orient).col;
        ctx.lineWidth = 1.6;
        line(ctx, a, b);
      }
      ctx.globalAlpha = 1;
      for (let i = Math.max(0, pts.length - 40); i < pts.length; i++) {
        const q = project(pts[i].p, w, h);
        ctx.fillStyle = pts[i].err ? '#FF004D' : col0 || (PHASES[pts[i].ph] || PHASES.orient).col;
        ctx.globalAlpha = 0.25 + 0.75 * (i / pts.length);
        ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      const cur = project(pts[pts.length - 1].p, w, h);
      const pulse = 4 + 2 * Math.sin(t / 200);
      ctx.strokeStyle = col0 || '#fff1e8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cur[0], cur[1], pulse, 0, Math.PI * 2); ctx.stroke();
      if (multi) { ctx.fillStyle = col0; ctx.fillText(tj.name, cur[0] + 7, cur[1] + 4); }
    });
  }
  function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }

  // ---------------------------------------------------------------- radar delle 7 dimensioni
  function currentVec(tj, T) {
    for (let i = tj.steps.length - 1; i >= 0; i--) if (tj.steps[i][0] <= T && tj.steps[i][5]) return tj.steps[i];
    return null;
  }
  function drawRadar() {
    const cv = el().querySelector('.wm-radar canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#07060c'; ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2 + 4, R = Math.min(w * 0.3, h * 0.36), n = 7;
    const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
    ctx.strokeStyle = '#2a2440'; ctx.lineWidth = 1;
    for (const k of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const a = ang(i % n); const x = cx + Math.cos(a) * R * k, y = cy + Math.sin(a) * R * k; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
    ctx.font = '13px VT, monospace'; ctx.fillStyle = '#c2c3c7';
    for (let i = 0; i < n; i++) {
      const a = ang(i);
      ctx.strokeStyle = '#2a2440'; line(ctx, [cx, cy], [cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
      const lx = cx + Math.cos(a) * (R + 8), ly = cy + Math.sin(a) * (R + 8);
      ctx.textAlign = Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center';
      ctx.fillText(DIM_LABELS[i], lx, ly + 4);
    }
    ctx.textAlign = 'left';
    const d = W.data;
    if (!d) return;
    const T = nowT();
    const phaseEl = el().querySelector('.wm-phase');
    d.trajectories.slice(0, 8).forEach((tj, ai) => {
      const st = currentVec(tj, T);
      if (!st) return;
      const v = st[5];
      const col = d.trajectories.length > 1 ? AGENT_COLS[ai % AGENT_COLS.length] : (PHASES[st[6]] || PHASES.orient).col;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const a = ang(i % n), r = R * Math.max(0.03, v[i % n]); const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.globalAlpha = 0.25; ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      if (ai === 0 && d.trajectories.length === 1) {
        const ph = PHASES[st[6]] || PHASES.orient;
        const html = `<b style="background:${ph.col}">${esc(ph.label)}</b> ${esc(ph.help)}`;
        if (phaseEl._h !== html) { phaseEl.innerHTML = html; phaseEl._h = html; }
      }
    });
    if (d.trajectories.length !== 1) {
      const counts = {};
      for (const tj of d.trajectories) { const st = currentVec(tj, T); if (st) counts[st[6]] = (counts[st[6]] || 0) + 1; }
      const html = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => `<b style="background:${(PHASES[k] || PHASES.orient).col}">${esc((PHASES[k] || PHASES.orient).label)} ${c}</b>`).join(' ');
      if (phaseEl._h !== html) { phaseEl.innerHTML = html; phaseEl._h = html; }
    }
  }

  // ---------------------------------------------------------------- linea del tempo con le fasi
  function drawTimeline() {
    const e = el();
    const cv = e.querySelector('.wm-band');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#07060c'; ctx.fillRect(0, 0, w, h);
    const d = W.data;
    if (!d && W.view !== 'mind') return;
    const [a, b] = span();
    const x = t => ((t - a) / (b - a)) * w;
    if (W.view === 'mind') drawMindBand(ctx, w, h, x, a, b);
    else d.trajectories.slice(0, 12).forEach((tj, ai, arr) => {
      const rowH = h / arr.length;
      for (let i = 0; i < tj.steps.length; i++) {
        const s = tj.steps[i], nx = i + 1 < tj.steps.length ? tj.steps[i + 1][0] : b;
        ctx.fillStyle = (PHASES[s[6]] || PHASES.orient).col;
        ctx.fillRect(x(s[0]), ai * rowH, Math.max(1, x(nx) - x(s[0])), Math.max(1, rowH - 1));
        if (s[4] === 1) { ctx.fillStyle = '#000'; ctx.fillRect(x(s[0]), ai * rowH + rowH / 2 - 1, 2, 2); }
      }
    });
    // sorprese sulla linea del tempo, colorate per reazione
    if (W.view === 'surp' && W.ground) for (const s of W.ground.surprises) if (s.t >= a && s.t <= b) { ctx.fillStyle = REACT[s.reaction] ? REACT[s.reaction][1] : '#c2c3c7'; const hh = Math.max(3, s.value * h); ctx.fillRect(x(s.t) - 1, h - hh, 3, hh); }
    // mappa contro territorio: affermazioni (colore dell'esito), ricordi scaduti e fantasmi sulla linea del tempo
    if (W.view === 'ground' && W.ground) {
      const tick = (t, col, y0, hh) => { if (t >= a && t <= b) { ctx.fillStyle = col; ctx.fillRect(x(t) - 1, y0, 3, hh); } };
      for (const c of W.ground.claims) tick(c.t, c.status === 'grounded' ? '#00e436' : c.status === 'contradicted' ? '#ff004d' : '#ffec27', 0, h / 2);
      for (const s of W.ground.stale) tick(s.changedAt || s.readAt, '#ffa300', h / 2, h / 2);
      for (const g of W.ground.ghosts) tick(g.t, '#ff77a8', h / 2, h / 2);
    }
    const T = W.T == null ? b : W.T;
    ctx.fillStyle = '#fff1e8'; ctx.fillRect(x(T) - 1, 0, 2, h);
    const range = e.querySelector('input[type=range]');
    if (document.activeElement !== range) range.value = W.T == null ? 1000 : Math.round(1000 * (W.T - a) / (b - a));
    const clock = e.querySelector('.wm-clock');
    const txt = W.T == null ? tr('in diretta') : new Date(W.T).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (clock._t !== txt) { clock.textContent = txt; clock._t = txt; }
    e.querySelector('.wm-play').textContent = W.playing ? '❚❚' : '▶';
    e.querySelector('.wm-live').classList.toggle('on', W.T == null);
  }


  // ================================================================ BOLLA DEL CONTESTO E STELLA POLARE (sperimentale)
  const KIND_COL = { prompt: '#FFEC27', file: '#29ADFF', search: '#1D7FD0', output: '#00E436', web: '#FF77A8', reply: '#FFF1E8', thinking: '#B8A6E0', report: '#FFA300', action: '#83769C', result: '#83769C', summary: '#FFFFFF' };
  const KIND_NAME = { prompt: tr('compito'), file: tr('file letto'), search: tr('risultati di ricerca'), output: tr('output di un comando'), web: tr('pagina web'), reply: tr('sua risposta'), thinking: tr('suo ragionamento'), report: tr('rapporto di un sottoagente'), action: tr('azione'), result: tr('risultato'), summary: tr('riassunto della compattazione') };
  const CLUSTER_COLS = ['#00E436', '#29ADFF', '#FFEC27', '#FF77A8', '#FFA300', '#C2C3C7'];
  function limitOf(hist) { let mx = 0; for (const h of hist || []) mx = Math.max(mx, h[1]); return mx > 200000 ? 1000000 : 200000; }
  function ctxAt(id, T) {
    const m = W.mind; if (!m) return 0;
    const c = m.ctx.find(x => x.id === id) || m.ctx[0];
    if (!c) return 0;
    let v = 0;
    for (const h of c.hist) { if (h[0] <= T) v = h[1]; else break; }
    return T === Infinity && m.ctxNow && m.ctxNow[c.id] ? m.ctxNow[c.id] : v;
  }
  function genAt(owner, T) {
    const c = W.mind.ctx.find(x => x.id === owner);
    return c ? c.compactions.filter(k => k.t <= T).length : 0;
  }
  function drawBubble(t) {
    const e = el();
    const cv = e.querySelector('.wm-bub canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#04030a'; ctx.fillRect(0, 0, w, h);
    const m = W.mind;
    if (!m || m.empty || !m.pieces) { ctx.fillStyle = '#83769C'; ctx.font = '18px VT, monospace'; ctx.fillText(m && m.empty ? tr('Ancora niente nel contesto di questo agente.') : tr('Carico la mappa…'), 12, 24); return; }
    W.pz = zoomOf('bub');
    if (!W.drag && W.pz.k === 1) W.yaw += 0.002;
    const T = nowT();
    const single = m.ctx.length === 1;
    const mainId = m.ctx[0] && m.ctx[0].id;
    const fill = single ? Math.min(1, ctxAt(mainId, T) / limitOf(m.ctx[0].hist)) : 0.55;
    const R = 0.55 + 0.5 * fill;
    const bubCol = fill >= 0.85 ? '#FF004D' : fill >= 0.6 ? '#FFEC27' : '#00E436';
    const proj = p => project(p, w, h);
    // la bolla: meridiani e paralleli
    ctx.lineWidth = 1;
    ctx.strokeStyle = bubCol; ctx.globalAlpha = 0.28;
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 6;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) { const th = i / 40 * Math.PI * 2; const q = proj([R * Math.cos(th) * Math.cos(a), R * Math.sin(th), R * Math.cos(th) * Math.sin(a)]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }
      ctx.stroke();
    }
    for (const lat of [-0.5, 0, 0.5]) {
      const rr = R * Math.cos(lat), y = R * Math.sin(lat);
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) { const th = i / 40 * Math.PI * 2; const q = proj([rr * Math.cos(th), y, rr * Math.sin(th)]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // i pezzi del contesto: dentro la bolla quelli presenti, fuori (polvere) quelli dimenticati
    const live = m.pieces.filter(p => p[0] <= T);
    const pts = [];
    live.forEach((p, i) => {
      const forgotten = p[4] < genAt(p[9], T);
      let v = [p[5], p[6], p[7]];
      const len = Math.hypot(v[0], v[1], v[2]) || 1;
      if (forgotten) { const k = (R * 1.15 + 0.12 * ((i * 7) % 5) / 5) / len; v = v.map(x => x * k); }
      else { const k = Math.min(1, 0.95 / Math.max(1, len)) * R * 0.95; v = v.map(x => x * k); }
      const q = proj(v);
      pts.push({ p, q, forgotten, rank: i / Math.max(1, live.length - 1) });
    });
    pts.sort((a, b) => b.q[2] - a.q[2]); // prima i lontani
    for (const it of pts) {
      const { p, q, forgotten, rank } = it;
      const r = forgotten ? 1.4 : Math.min(8, 2 + Math.sqrt(p[3]) / 12) * (p[1] === 'summary' ? 1.6 : 1);
      ctx.globalAlpha = forgotten ? 0.3 : 0.35 + 0.65 * rank;
      ctx.fillStyle = forgotten ? '#5F574F' : p[10] ? '#FF004D' : !single ? AGENT_COLS[Object.keys(m.names).indexOf(p[9]) % AGENT_COLS.length] : (KIND_COL[p[1]] || '#C2C3C7');
      ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill();
      it.r = r;
    }
    ctx.globalAlpha = 1;
    // etichette dei gruppi di significato, al centro dei loro pezzi presenti
    ctx.font = '13px VT, monospace';
    for (const c of m.clusters) {
      const mem = pts.filter(it => !it.forgotten && it.p[8] === c.id);
      if (mem.length < 2) continue;
      const cx = mem.reduce((a, it) => a + it.q[0], 0) / mem.length, cy = mem.reduce((a, it) => a + it.q[1], 0) / mem.length;
      ctx.fillStyle = CLUSTER_COLS[c.id % CLUSTER_COLS.length];
      ctx.globalAlpha = 0.9; ctx.fillText(c.label, cx + 6, cy - 6); ctx.globalAlpha = 1;
    }
    // la stella polare (e le stelle dei compiti precedenti)
    const goals = m.goals.filter(g => g[0] <= T);
    const curGoal = new Map();
    for (const g of goals) curGoal.set(g[5], g);
    goals.forEach(g => {
      const len = Math.hypot(g[2], g[3], g[4]) || 1, k = Math.min(1, 0.95 / Math.max(1, len)) * R * 0.95;
      const q = proj([g[2] * k, g[3] * k, g[4] * k]);
      const cur = curGoal.get(g[5]) === g;
      drawStarShape(ctx, q[0], q[1], cur ? 9 + Math.sin(t / 300) : 4, cur ? '#FFEC27' : '#7a6a20');
      if (cur && single) { ctx.fillStyle = '#FFEC27'; ctx.font = '14px VT, monospace'; ctx.fillText(clipText(ctx, g[1], 220), q[0] + 12, q[1] + 4); }
    });
    // percentuale di riempimento
    ctx.font = '16px VT, monospace'; ctx.fillStyle = bubCol;
    if (single) ctx.fillText(tr('contesto pieno al {p}%', { p: Math.round(fill * 100) }), 10, h - 10);
    // tooltip
    const tip = e.querySelector('.wm-bub .wm-tip');
    let best = null, bd = 9;
    if (W.mhover) for (const it of pts) { const d2 = Math.hypot(it.q[0] - W.mhover.x, it.q[1] - W.mhover.y); if (d2 < Math.max(bd, it.r + 2)) { bd = d2; best = it; } }
    if (best && !W.drag) {
      const p = best.p;
      const html = `<b>${esc(p[2])}</b><br>${esc(KIND_NAME[p[1]] || p[1])} · ${esc(tr('{n} token', { n: p[3] }))} · ${esc(new Date(p[0]).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }))}${!single ? ' · ' + esc(m.names[p[9]] || '') : ''}${best.forgotten ? '<br><span class="dim">' + esc(tr('dimenticato in una compattazione')) + '</span>' : ''}`;
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      tip.hidden = false; tip.style.left = Math.min(w - 220, W.mhover.x + 12) + 'px'; tip.style.top = Math.min(h - 50, W.mhover.y + 12) + 'px';
    } else tip.hidden = true;
    const stats = e.querySelector('.wm-stats');
    const nLive = pts.filter(x => !x.forgotten).length, nGone = pts.length - nLive;
    const txt = tr('{n} pezzi nel contesto · {g} dimenticati · {c} compattazioni', { n: nLive, g: nGone, c: single ? m.ctx[0].compactions.filter(k => k.t <= T).length : m.ctx.reduce((a, c) => a + c.compactions.length, 0) });
    if (stats._t !== txt) { stats.textContent = txt; stats._t = txt; }
  }
  function drawStarShape(ctx, x, y, r, col) {
    ctx.fillStyle = col; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill();
  }
  // allineamento relativo: 1 = parla del compito come all'inizio; sotto 0,35 per 6 azioni di fila = deriva
  function driftOf(al) {
    let run = 0;
    for (let i = al.length - 1; i >= 0; i--) { if (al[i][2] / al[i][3] < 0.35) run++; else break; }
    return run;
  }
  function drawStar() {
    const e = el();
    const cv = e.querySelector('.wm-star canvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#07060c'; ctx.fillRect(0, 0, w, h);
    const info = e.querySelector('.wm-starinfo');
    const m = W.mind;
    const setInfo = html => { if (info._h !== html) { info.innerHTML = html; info._h = html; } };
    if (!m || !m.align || m.ctx.length !== 1) { setInfo(`<span class="dim">${esc(m && m.ctx && m.ctx.length > 1 ? tr('Scegli un singolo agente per vedere quanto resta sul suo compito.') : tr('Nessun compito ancora.'))}</span>`); return; }
    const T = nowT();
    const al = m.align.filter(a => a[0] <= T);
    if (!al.length) { setInfo(`<span class="dim">${esc(tr('Nessuna azione da confrontare con il compito, per ora.'))}</span>`); return; }
    const [a, b] = span();
    const pad = 4, x = t => pad + ((t - a) / (b - a)) * (w - 2 * pad);
    const y = v => h - 6 - Math.min(1.3, v) / 1.3 * (h - 14);
    // fasce: sulla rotta, incerto, alla deriva
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#00E436'; ctx.fillRect(0, y(1.3), w, y(0.6) - y(1.3));
    ctx.fillStyle = '#FFEC27'; ctx.fillRect(0, y(0.6), w, y(0.35) - y(0.6));
    ctx.fillStyle = '#FF004D'; ctx.fillRect(0, y(0.35), w, y(0) - y(0.35));
    ctx.globalAlpha = 1;
    // cambi di compito
    ctx.font = '13px VT, monospace';
    for (const g of m.goals) { if (g[0] > T || g[0] < a) continue; ctx.strokeStyle = '#FFEC27'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(g[0]), 0); ctx.lineTo(x(g[0]), h); ctx.stroke(); ctx.setLineDash([]); drawStarShape(ctx, x(g[0]) + 5, 8, 4, '#FFEC27'); }
    // punti grezzi e linea smussata
    for (const p of al) { ctx.fillStyle = p[6] ? '#FF004D' : '#5F574F'; ctx.fillRect(x(p[0]) - 1, y(p[1] / p[3]) - 1, 2, 2); }
    ctx.strokeStyle = '#FFF1E8'; ctx.lineWidth = 2; ctx.beginPath();
    al.forEach((p, i) => { const px = x(p[0]), py = y(p[2] / p[3]); i && al[i - 1][4] === p[4] ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); // la linea riparte a ogni nuovo compito
    ctx.stroke(); ctx.lineWidth = 1;
    const last = al[al.length - 1], rel = last[2] / last[3];
    const run = driftOf(al);
    const goal = m.goals.filter(g => g[0] <= T).pop();
    const since = al.filter(p => p[4] === last[4]);
    const near = since.slice().sort((p, q) => q[1] - p[1]).slice(0, 2), far = since.slice(-12).sort((p, q) => p[1] - q[1]).slice(0, 2);
    const weak = last[3] <= 0.031; // le parole del compito non compaiono mai nel lavoro: non si può giudicare
    const state = weak ? `<b class="mid">${esc(tr('NON MISURABILE'))}</b> ${esc(tr('le parole del compito non compaiono nel suo lavoro'))}` : run >= 6 ? `<b class="bad">${esc(tr('ALLA DERIVA'))}</b> ${esc(trn('da {n} azione', 'da {n} azioni', run))}` : rel < 0.6 ? `<b class="mid">${esc(tr('SI ALLONTANA'))}</b>` : `<b class="ok">${esc(tr('SULLA ROTTA'))}</b>`;
    setInfo(`<div>${state} · ${esc(tr('allineamento {p}%', { p: Math.round(Math.min(1.3, rel) * 100) }))}</div>` +
      (goal ? `<div class="g">★ ${esc(goal[1])}</div>` : '') +
      `<div><span class="dim">${esc(tr('più vicine al compito:'))}</span> ${near.map(p => esc(p[5])).join(' · ') || '—'}</div>` +
      `<div><span class="dim">${esc(tr('più lontane, di recente:'))}</span> ${far.map(p => esc(p[5])).join(' · ') || '—'}</div>`);
  }
  function drawComposition() {
    const e = el(), box = e.querySelector('.wm-compbody');
    const m = W.mind;
    if (!m || !m.pieces) { if (box._h !== '') { box.innerHTML = ''; box._h = ''; } return; }
    const T = nowT();
    const live = m.pieces.filter(p => p[0] <= T && p[4] >= genAt(p[9], T));
    const tot = live.reduce((a, p) => a + p[3], 0) || 1;
    const byC = new Map();
    for (const p of live) byC.set(p[8], (byC.get(p[8]) || 0) + p[3]);
    const rows = m.clusters.map(c => ({ c, share: (byC.get(c.id) || 0) / tot })).filter(r => r.share > 0).sort((a, b) => b.share - a.share);
    const byK = new Map();
    for (const p of live) byK.set(p[1], (byK.get(p[1]) || 0) + p[3]);
    const kinds = [...byK.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let forgot = '';
    if (m.ctx.length === 1) {
      const comp = m.ctx[0].compactions.filter(k => k.t <= T).pop();
      if (comp) {
        const gone = m.pieces.filter(p => p[0] <= comp.t && p[4] < genAt(p[9], T) && p[1] !== 'action').sort((a, b) => b[3] - a[3]).slice(0, 4);
        forgot = `<div class="fg"><span class="dim">${esc(tr('Dimenticati nell\'ultima compattazione'))}${comp.pre ? ' (' + esc(tr('da {a} a {b} token', { a: Math.round(comp.pre / 1000) + 'k', b: Math.round(comp.post / 1000) + 'k' })) + ')' : ''}:</span> ${gone.map(p => esc(p[2])).join(' · ') || '—'}</div>`;
      }
    }
    const html = rows.map(r => `<div class="cr"><span class="cl" style="color:${CLUSTER_COLS[r.c.id % CLUSTER_COLS.length]}">${esc(r.c.label)}</span><span class="cb"><i style="width:${Math.round(r.share * 100)}%;background:${CLUSTER_COLS[r.c.id % CLUSTER_COLS.length]}"></i></span><span class="cp">${Math.round(r.share * 100)}%</span></div>`).join('') +
      `<div class="kinds">${kinds.map(([k, v]) => `<span><i style="background:${KIND_COL[k] || '#C2C3C7'}"></i>${esc(KIND_NAME[k] || k)} ${Math.round(100 * v / tot)}%</span>`).join('')}</div>` + forgot;
    if (box._h !== html) { box.innerHTML = html; box._h = html; }
  }
  // linea del tempo della vista "mente": quanto è pieno il contesto, con le compattazioni
  function drawMindBand(ctx, w, h, x, a, b) {
    const m = W.mind;
    if (!m || !m.ctx) return;
    const c = m.ctx[0];
    if (m.ctx.length === 1 && c.hist.length) {
      const lim = limitOf(c.hist);
      for (let i = 0; i < c.hist.length; i++) {
        const [t0, v] = c.hist[i], t1 = i + 1 < c.hist.length ? c.hist[i + 1][0] : b;
        const f = Math.min(1, v / lim);
        ctx.fillStyle = f >= 0.85 ? '#FF004D' : f >= 0.6 ? '#FFEC27' : '#00E436';
        const hh = Math.max(1, f * h);
        ctx.fillRect(x(t0), h - hh, Math.max(1, x(t1) - x(t0)), hh);
      }
      for (const k of c.compactions) { ctx.fillStyle = '#FFF1E8'; ctx.fillRect(x(k.t) - 1, 0, 3, h); }
    } else {
      for (const p of m.pieces) { ctx.fillStyle = KIND_COL[p[1]] || '#C2C3C7'; ctx.fillRect(x(p[0]), 2, 1, h - 4); }
    }
  }

  function loop(t) {
    if (!W.open) return;
    const dt = Math.min(0.1, (t - (W.lastFrame || t)) / 1000);
    W.lastFrame = t;
    if (W.playing && W.T != null) {
      const [a, b] = span();
      W.T += (b - a) * dt / 20; // tutta la storia in 20 secondi
      if (W.T >= b) { W.T = null; W.playing = false; }
    }
    try {
      if (W.view === 'mind') { drawBubble(t); drawStar(); drawComposition(); drawTimeline(); }
      else if (W.view === 'ground') { drawTerritory(t, '.wm-gterr'); drawGroundPanel(); drawTimeline(); }
      else if (W.view === 'surp') { drawSeismo(t); drawSurprisePanel(); drawTimeline(); }
      else { drawTerritory(t); drawTrajectory(t); drawRadar(); drawTimeline(); }
    } catch (err) { console.error(err); }
    requestAnimationFrame(loop);
  }
})();
