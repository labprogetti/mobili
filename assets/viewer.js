// Visualizzatore mobili — logica comune a tutte le pagine.
// Ogni pagina definisce window.NOTE (le note cliccabili) prima di caricare questo file.
//
// Stanza di contorno: se nel modello c'è un gruppo il cui nome contiene "Stanza"
// (pareti, pavimento…), la pagina lo esclude da quote e inquadratura, lo mostra
// trasparente (scelta nel menu "Stanza") e lo nasconde in realtà aumentata.

const mv = document.querySelector('#mv');
const NOTE = Array.isArray(window.NOTE) ? window.NOTE : [];
const MODO_AUTORE = new URLSearchParams(location.search).has('autore');

await customElements.whenDefined('model-viewer');

// ---------- Barra di caricamento ----------

const barra = mv.querySelector('.barra');
const riempimento = mv.querySelector('.barra-riempimento');

mv.addEventListener('progress', (e) => {
  const p = e.detail.totalProgress;
  riempimento.style.width = `${Math.round(p * 100)}%`;
  barra.classList.toggle('nascosta', p >= 1);
});

mv.addEventListener('error', () => {
  barra.classList.add('nascosta');
  avviso('Non riesco a caricare il modello. Ricarica la pagina; se il problema resta, avvisa chi te l\'ha mandata.', 0);
});

// ---------- Scena interna di model-viewer ----------
// model-viewer non espone i singoli pezzi del modello: si passa dalla sua scena three.js.
// Verificato con model-viewer 4.2.0. Se una versione futura la cambia, la pagina torna
// al comportamento base: quote e inquadratura su tutto il modello, niente menu Stanza.

function scenaInterna() {
  const s = Object.getOwnPropertySymbols(mv).find((x) => x.description === 'scene');
  const scena = s && mv[s];
  return scena && scena._model && scena.boundingBox ? scena : null;
}

function discendeDa(o, radice) {
  for (let p = o; p; p = p.parent) if (p === radice) return true;
  return false;
}

// Divide il modello in mobile e stanza; misura il mobile in coordinate del modello
// (le stesse di data-position e delle quote).
function analizzaModello() {
  const scena = scenaInterna();
  if (!scena) return null;
  const modello = scena._model;
  modello.updateMatrixWorld(true);
  const Box = scena.boundingBox.constructor;
  const Mat = modello.matrixWorld.constructor;
  const inversa = new Mat().copy(modello.matrixWorld).invert();
  const rel = new Mat();

  const radici = [];
  modello.traverse((o) => {
    if (/stanza/i.test(o.name) && !radici.some((r) => discendeDa(o, r))) radici.push(o);
  });

  const boxMobile = new Box();
  const pezziStanza = [];
  modello.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    rel.multiplyMatrices(inversa, o.matrixWorld);
    const b = o.geometry.boundingBox.clone().applyMatrix4(rel);
    if (radici.some((r) => discendeDa(o, r))) {
      // Superfici piatte e orizzontali = pavimento: resta sempre pieno.
      pezziStanza.push({ mesh: o, originale: o.material, pavimento: b.max.y - b.min.y < 0.02 });
    } else {
      boxMobile.union(b);
    }
  });

  return { scena, pezziStanza, box: boxMobile.isEmpty() ? null : boxMobile };
}

// ---------- Stanza: piena, trasparente, nascosta ----------

const sceltaStanza = document.querySelector('#modo-stanza');
let stanza = null; // { scena, pezzi }
const versioniTrasparenti = new Map();
const nessunRaycast = () => {};

function trasparente(m) {
  if (Array.isArray(m)) return m.map(trasparente);
  if (!versioniTrasparenti.has(m)) {
    const t = m.clone();
    t.transparent = true;
    t.opacity = 0.15;
    t.depthWrite = false;
    versioniTrasparenti.set(m, t);
  }
  return versioniTrasparenti.get(m);
}

function mostraStanza(modo) {
  if (!stanza) return;
  for (const p of stanza.pezzi) {
    p.mesh.visible = modo !== 'nascosta';
    p.mesh.material = modo === 'trasparente' && !p.pavimento ? trasparente(p.originale) : p.originale;
    // Se la stanza non è piena, il doppio clic deve "passarci attraverso" e colpire il mobile.
    if (modo === 'piena') delete p.mesh.raycast;
    else p.mesh.raycast = nessunRaycast;
  }
  stanza.scena.queueRender();
}

sceltaStanza?.addEventListener('change', () => mostraStanza(sceltaStanza.value));

// In realtà aumentata si vede solo il mobile. Il visore AR dell'iPhone (Quick Look)
// non segnala quando si chiude: la stanza torna alla prima interazione con la pagina.
let stanzaNascostaPerAR = false;
const bottoneAR = mv.querySelector('[slot="ar-button"]');

bottoneAR?.addEventListener('click', () => {
  if (!stanza) return;
  stanzaNascostaPerAR = true;
  mostraStanza('nascosta');
});

function ripristinaDopoAR() {
  if (!stanzaNascostaPerAR) return;
  stanzaNascostaPerAR = false;
  mostraStanza(sceltaStanza?.value || 'trasparente');
}

mv.addEventListener('ar-status', (e) => {
  if (e.detail.status === 'not-presenting' || e.detail.status === 'failed') ripristinaDopoAR();
});
document.addEventListener('pointerdown', (e) => {
  if (!bottoneAR?.contains(e.target)) ripristinaDopoAR();
});

// ---------- Movimenti della camera ----------

const FOV = 30; // gradi, fisso: serve per calcolare la distanza della camera

// Ingombro del mobile, impostato al caricamento del modello.
let mobile = null; // { min, max, centro, dim, raggio }

function vaiA({ target, orbit, fov = `${FOV}deg` }) {
  mv.cameraTarget = target || (mobile ? xyz(mobile.centro) : 'auto auto auto');
  if (orbit) mv.cameraOrbit = orbit;
  mv.fieldOfView = fov;
}

// Da che parte guarda il fronte del mobile, negli assi del modello (window.FRONTE nella pagina).
// n = direzione del fronte, d = destra di chi guarda il fronte, ang = rotazione delle viste.
const FRONTI = {
  '+z': { n: { x: 0, z: 1 }, d: { x: 1, z: 0 }, ang: 0 },
  '+x': { n: { x: 1, z: 0 }, d: { x: 0, z: -1 }, ang: 90 },
  '-z': { n: { x: 0, z: -1 }, d: { x: -1, z: 0 }, ang: 180 },
  '-x': { n: { x: -1, z: 0 }, d: { x: 0, z: 1 }, ang: -90 },
};
const FRONTE = FRONTI[window.FRONTE] || FRONTI['+z'];

// [theta, phi] rispetto al fronte del mobile
const VISTE = {
  fronte: [0, 90],
  lato: [90, 90],
  pianta: [0, 0],
  prospettiva: [35, 65],
};

function angoliVista(nome) {
  const [theta, phi] = VISTE[nome];
  return `${theta + FRONTE.ang}deg ${phi}deg`;
}

// Distanza che fa stare tutto il mobile nel riquadro, con margine per le linee di quota.
// Tiene conto della forma del riquadro: su schermo verticale (telefono) va più lontano.
function distanza() {
  const v = (FOV * Math.PI) / 180;
  const o = 2 * Math.atan(Math.tan(v / 2) * (mv.clientWidth / mv.clientHeight));
  return (mobile.raggio * 1.15) / Math.sin(Math.min(v, o) / 2);
}

function orbitaVista(nome) {
  if (!mobile) return `${angoliVista(nome)} ${mv.clientWidth < mv.clientHeight ? '170%' : '125%'}`;
  return `${angoliVista(nome)} ${distanza().toFixed(2)}m`;
}

mv.cameraOrbit = orbitaVista('prospettiva');

const bottoniVista = document.querySelectorAll('[data-vista]');

function segnaVista(attivo) {
  bottoniVista.forEach((b) => b.setAttribute('aria-pressed', String(b === attivo)));
}

bottoniVista.forEach((b) => {
  b.addEventListener('click', () => {
    vaiA({ orbit: orbitaVista(b.dataset.vista) });
    segnaVista(b);
  });
});

// Se l'utente ruota il modello a mano, nessuna vista resta evidenziata.
mv.addEventListener('camera-change', (e) => {
  if (e.detail.source === 'user-interaction') segnaVista(null);
});

// ---------- Note (hotspot) ----------

const elenco = document.querySelector('#elenco-note');

function apriNota(indice) {
  mv.querySelectorAll('.nota').forEach((el, i) => el.classList.toggle('aperta', i === indice));
  document.querySelectorAll('#elenco-note button').forEach((el, i) => el.classList.toggle('attiva', i === indice));
  const n = NOTE[indice];
  vaiA({ target: n.position, orbit: n.orbit });
  segnaVista(null);
}

NOTE.forEach((n, i) => {
  const b = document.createElement('button');
  b.className = 'nota';
  b.slot = `hotspot-nota-${i}`;
  b.dataset.position = n.position;
  if (n.normal) b.dataset.normal = n.normal;
  b.setAttribute('aria-label', `Nota ${i + 1}: ${n.testo}`);
  const numero = document.createElement('span');
  numero.className = 'nota-numero';
  numero.textContent = i + 1;
  const testo = document.createElement('span');
  testo.className = 'nota-testo';
  testo.textContent = n.testo;
  b.append(numero, testo);
  b.addEventListener('click', () => apriNota(i));
  mv.appendChild(b);

  if (elenco) {
    const li = document.createElement('li');
    const voce = document.createElement('button');
    voce.type = 'button';
    voce.textContent = n.testo;
    voce.addEventListener('click', () => apriNota(i));
    li.appendChild(voce);
    elenco.appendChild(li);
  }
});

if (elenco && NOTE.length === 0) elenco.closest('section')?.setAttribute('hidden', '');

// Le note sul lato nascosto del mobile diventano trasparenti.
function aggiornaNote() {
  mv.querySelectorAll('.nota').forEach((el) => {
    const h = mv.queryHotspot(el.slot);
    if (h) el.classList.toggle('dietro', !h.facingCamera);
  });
}

// ---------- Quote (ingombro L × P × H) ----------

const QUOTE = ['l', 'p', 'h']; // larghezza, profondità, altezza

function creaHotspot(nome, classe) {
  const el = document.createElement('div');
  el.slot = `hotspot-${nome}`;
  el.className = classe;
  el.dataset.position = '0m 0m 0m';
  mv.appendChild(el);
  return el;
}

const etichette = {};
for (const nome of QUOTE) {
  creaHotspot(`quota-${nome}-a`, 'quota-punto');
  creaHotspot(`quota-${nome}-b`, 'quota-punto');
  etichette[nome] = creaHotspot(`quota-${nome}`, 'quota-etichetta');
}
// L'altezza sta sullo spigolo più a sinistra: l'etichetta va verso il mobile, non fuori dal riquadro.
etichette.h.classList.add('quota-verticale');

const linee = mv.querySelector('.linee-quote');

function cm(metri) {
  const v = Math.round(metri * 1000) / 10;
  return `${String(v).replace('.', ',')} cm`;
}

function xyz(v) {
  return `${v.x}m ${v.y}m ${v.z}m`;
}

function disegnaQuote() {
  for (const nome of QUOTE) {
    const a = mv.queryHotspot(`hotspot-quota-${nome}-a`);
    const b = mv.queryHotspot(`hotspot-quota-${nome}-b`);
    const linea = linee.querySelector(`[data-quota="${nome}"]`);
    if (!a || !b || !linea) continue;
    linea.setAttribute('x1', a.canvasPosition.x);
    linea.setAttribute('y1', a.canvasPosition.y);
    linea.setAttribute('x2', b.canvasPosition.x);
    linea.setAttribute('y2', b.canvasPosition.y);
  }
}

function piazzaQuote() {
  const { min, max, centro: c, dim: s } = mobile;
  const { n, d } = FRONTE;
  // Mezze misure lungo la destra (larghezza) e lungo il fronte (profondità)
  const hd = (Math.abs(d.x) * s.x + Math.abs(d.z) * s.z) / 2;
  const hf = (Math.abs(n.x) * s.x + Math.abs(n.z) * s.z) / 2;
  const m = Math.max(s.x, s.y, s.z) * 0.06; // distanza delle linee di quota dal mobile

  // Punto dato da: spostamento a destra, altezza, spostamento verso il fronte (dal centro)
  const p = (destra, y, avanti) =>
    `${c.x + destra * d.x + avanti * n.x}m ${y}m ${c.z + destra * d.z + avanti * n.z}m`;

  const posizioni = {
    // larghezza: davanti, in basso
    'quota-l-a': p(-hd, min.y, hf + m),
    'quota-l-b': p(hd, min.y, hf + m),
    'quota-l': p(0, min.y, hf + m),
    // profondità: lato destro, in basso
    'quota-p-a': p(hd + m, min.y, hf),
    'quota-p-b': p(hd + m, min.y, -hf),
    'quota-p': p(hd + m, min.y, 0),
    // altezza: spigolo davanti a sinistra
    'quota-h-a': p(-hd - m, min.y, hf),
    'quota-h-b': p(-hd - m, max.y, hf),
    'quota-h': p(-hd - m, c.y, hf),
  };
  for (const [nome, position] of Object.entries(posizioni)) {
    mv.updateHotspot({ name: `hotspot-${nome}`, position });
  }

  const misure = { l: 2 * hd, p: 2 * hf, h: s.y };
  for (const nome of QUOTE) {
    etichette[nome].textContent = `${nome.toUpperCase()} ${cm(misure[nome])}`;
  }

  const ingombro = document.querySelector('#ingombro');
  if (ingombro) ingombro.textContent = `Ingombro: L ${cm(misure.l)} × P ${cm(misure.p)} × H ${cm(misure.h)}`;
}

// ---------- Caricamento del modello ----------

mv.addEventListener('load', () => {
  const analisi = analizzaModello();

  let min, max;
  if (analisi?.box) {
    ({ min, max } = analisi.box);
  } else {
    const c = mv.getBoundingBoxCenter();
    const s = mv.getDimensions();
    min = { x: c.x - s.x / 2, y: c.y - s.y / 2, z: c.z - s.z / 2 };
    max = { x: c.x + s.x / 2, y: c.y + s.y / 2, z: c.z + s.z / 2 };
  }
  const dim = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  mobile = {
    min,
    max,
    dim,
    centro: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    raggio: Math.hypot(dim.x, dim.y, dim.z) / 2,
  };

  if (analisi?.pezziStanza.length) {
    stanza = { scena: analisi.scena, pezzi: analisi.pezziStanza };
    sceltaStanza?.closest('label')?.removeAttribute('hidden');
    mostraStanza(sceltaStanza?.value || 'trasparente');
    // Scene Viewer (Android) carica il file così com'è, stanza compresa: si usa WebXR.
    mv.setAttribute('ar-modes', 'webxr quick-look');
    // Sotto il pavimento non c'è niente da vedere.
    mv.maxCameraOrbit = 'auto 90deg 300%';
  }

  piazzaQuote();
  vaiA({ orbit: orbitaVista('prospettiva') });
  segnaVista(document.querySelector('[data-vista="prospettiva"]'));
  mv.jumpCameraToGoal();
  requestAnimationFrame(() => {
    disegnaQuote();
    aggiornaNote();
  });
});

mv.addEventListener('camera-change', () => {
  disegnaQuote();
  aggiornaNote();
});
window.addEventListener('resize', () => requestAnimationFrame(disegnaQuote));

const interruttoreQuote = document.querySelector('#mostra-quote');
interruttoreQuote?.addEventListener('change', () => {
  mv.classList.toggle('senza-quote', !interruttoreQuote.checked);
});

// ---------- Doppio clic: coordinate per nuove note ----------

mv.addEventListener('dblclick', async (e) => {
  const hit = mv.positionAndNormalFromPoint(e.clientX, e.clientY);
  if (!hit) {
    console.info('Doppio clic fuori dal modello: nessuna coordinata.');
    return;
  }
  const pos = hit.position;
  const nor = hit.normal;
  const o = mv.getCameraOrbit();
  const gradi = (rad) => Math.round((rad * 180) / Math.PI);
  const riga =
    `{ testo: "…", ` +
    `position: "${pos.x.toFixed(3)}m ${pos.y.toFixed(3)}m ${pos.z.toFixed(3)}m", ` +
    `normal: "${nor.x.toFixed(3)} ${nor.y.toFixed(3)} ${nor.z.toFixed(3)}", ` +
    `orbit: "${gradi(o.theta)}deg ${gradi(o.phi)}deg ${o.radius.toFixed(2)}m" },`;
  console.log(riga);

  if (MODO_AUTORE) {
    try {
      await navigator.clipboard.writeText(riga);
      avviso('Nota copiata negli appunti: incollala in window.NOTE.');
    } catch {
      avviso('Coordinate stampate nella console (F12).');
    }
  }
});

// ---------- Avvisi a comparsa ----------

function avviso(testo, durataMs = 3000) {
  let el = document.querySelector('.avviso');
  if (!el) {
    el = document.createElement('div');
    el.className = 'avviso';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = testo;
  el.classList.add('visibile');
  clearTimeout(avviso.timer);
  if (durataMs > 0) avviso.timer = setTimeout(() => el.classList.remove('visibile'), durataMs);
}
