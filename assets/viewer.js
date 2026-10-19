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

// Rotella del mouse più dolce: uno scatto avvicina del 6% invece del 14%. Sui touch screen
// resta il valore normale, altrimenti il pizzico con due dita diventa faticoso.
if (matchMedia('(pointer: fine)').matches) mv.zoomSensitivity = 0.35;

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
  // Se il mobile è in un gruppo "mobile", tutto il resto che non è Stanza (sedie, oggetti
  // sul piano…) è contorno: resta pieno, ma non conta per l'inquadratura e in AR si nasconde.
  // I suffissi di Blender (.001, .002…) per three.js diventano 001, 002…
  const radiciMobile = [];
  modello.traverse((o) => {
    if (/^(G-|C-)?mobile\d*$/i.test(o.name) && !radiciMobile.some((r) => discendeDa(o, r))) radiciMobile.push(o);
  });

  const boxMobile = new Box();
  const pezziStanza = [];
  const pezziContorno = [];
  modello.traverse((o) => {
    // Mesh e linee degli spigoli (tools/spigoli.mjs)
    if (!o.isMesh && !o.isLineSegments) return;
    // Le linee non devono intercettare il doppio clic: three.js le "colpisce" anche a distanza.
    if (o.isLineSegments) o.raycast = nessunRaycast;
    // Le facce vengono spinte appena indietro in profondità: gli spigoli, che stanno
    // esattamente sui loro bordi, altrimenti verrebbero coperti a tratti.
    if (o.isMesh) {
      for (const m of [].concat(o.material)) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        // Materiali specchio di SketchUp ("Mirror…", "Specchio…"): da SketchUp arrivano come
        // una semplice immagine grigia. Diventano metallo lucido che riflette l'ambiente.
        if (/mirror|specchio/i.test(m.name) && !m.userData.specchio) {
          m.userData.specchio = true;
          m.map = null;
          m.color.setRGB(0.92, 0.94, 0.95);
          m.metalness = 1;
          m.roughness = 0.04;
          m.needsUpdate = true;
        }
      }
    }
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    rel.multiplyMatrices(inversa, o.matrixWorld);
    const b = o.geometry.boundingBox.clone().applyMatrix4(rel);
    if (radici.some((r) => discendeDa(o, r))) {
      // Superfici piatte e orizzontali = pavimento: resta sempre pieno.
      pezziStanza.push({ mesh: o, originale: o.material, pavimento: o.isMesh && b.max.y - b.min.y < 0.02 });
    } else if (radiciMobile.length && !radiciMobile.some((r) => discendeDa(o, r))) {
      pezziContorno.push(o);
    } else if (o.isMesh) {
      boxMobile.union(b);
    }
  });

  return { scena, pezziStanza, pezziContorno, box: boxMobile.isEmpty() ? null : boxMobile };
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
    if (p.mesh.isMesh) {
      if (modo === 'piena') delete p.mesh.raycast;
      else p.mesh.raycast = nessunRaycast;
    }
  }
  stanza.scena.queueRender();
}

sceltaStanza?.addEventListener('change', () => mostraStanza(sceltaStanza.value));

// In realtà aumentata si vede solo il mobile: stanza e contorno (sedie, oggetti) spariscono.
// Il visore AR dell'iPhone (Quick Look) non segnala quando si chiude: tutto torna alla
// prima interazione con la pagina.
let stanzaNascostaPerAR = false;
let contorno = []; // pezzi di contorno, impostati al caricamento
const bottoneAR = mv.querySelector('[slot="ar-button"]');

bottoneAR?.addEventListener('click', () => {
  if (!stanza && !contorno.length) return;
  stanzaNascostaPerAR = true;
  if (stanza) mostraStanza('nascosta');
  for (const o of contorno) o.visible = false;
  mv.shadowIntensity = 1; // nella stanza vera serve l'ombra che "appoggia" il mobile a terra
});

function ripristinaDopoAR() {
  if (!stanzaNascostaPerAR) return;
  stanzaNascostaPerAR = false;
  for (const o of contorno) o.visible = true;
  if (stanza) {
    mostraStanza(sceltaStanza?.value || 'trasparente');
    mv.shadowIntensity = 0;
  }
}

mv.addEventListener('ar-status', (e) => {
  if (e.detail.status === 'not-presenting' || e.detail.status === 'failed') ripristinaDopoAR();
});
document.addEventListener('pointerdown', (e) => {
  if (!bottoneAR?.contains(e.target)) ripristinaDopoAR();
});

// ---------- Ante e cassetti che si aprono ----------
// Configurazione nella pagina (window.ANIMAZIONI), con i nomi dei gruppi di SketchUp:
//   ante:     [{ nome: "Anta", cerniera: "dx" | "sx" | "alto" | "basso", angolo: 95 }]
//             dx/sx = lato visto da chi sta davanti all'anta; alto = anta a ribalta verso l'alto.
//             L'anta si apre sempre verso l'esterno del mobile.
//   cassetti: { nomi: ["c1", "c2"], verso: "-z", corsa: 0.22, anta: "Anta" }
//             corsa in metri; anta = quella da aprire prima, se i cassetti ci passano davanti
// Il modello va esportato con ante e cassetti chiusi.

const ANIMAZIONI = window.ANIMAZIONI || {};
const bottoneAnte = document.querySelector('#apri-ante');
const bottoneCassetti = document.querySelector('#apri-cassetti');
// { scena, ante: [{ nome, perno, asse, angolo, valore }], cassetti: { lista, anta, valore } }
// valore: 0 = chiuso, 1 = aperto (anche valori intermedi durante il movimento)
let mobili = null;

// Stessa pulizia dei nomi che fa three.js: spazi → "_", via [ ] . : /
const nomeThree = (s) => s.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
const perRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function trovaGruppo(modello, nome) {
  // Blender aggiunge ".001", ".002"… se il nome c'è già nella scena: per three.js diventano "001"…
  const re = new RegExp(`^(G-|C-)?${perRegex(nomeThree(nome))}(\\d{3})?$`);
  let trovato = null;
  modello.traverse((o) => {
    if (!trovato && re.test(o.name)) trovato = o;
  });
  return trovato;
}

function preparaAnimazioni(scena) {
  const modello = scena._model;
  modello.updateMatrixWorld(true);
  const Vec = scena.boundingBox.min.constructor;
  const Mat = modello.matrixWorld.constructor;
  const versoModello = new Mat().copy(modello.matrixWorld).invert();
  const risultato = { scena, ante: [], cassetti: null };

  for (const cfg of ANIMAZIONI.ante || []) {
    const nodo = trovaGruppo(modello, cfg.nome);
    if (!nodo) {
      console.warn(`Anta "${cfg.nome}" non trovata nel modello`);
      continue;
    }
    // Pianta dell'anta: i due punti più lontani sono le sue estremità orizzontali.
    const punti = [];
    nodo.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      const rel = new Mat().multiplyMatrices(versoModello, o.matrixWorld);
      for (let i = 0; i < pos.count; i++) punti.push(new Vec().fromBufferAttribute(pos, i).applyMatrix4(rel));
    });
    // Direzione del lato lungo in pianta: asse principale dei vertici (x-z). I due vertici più
    // lontani non vanno bene: su un pannello sottile sono gli angoli in diagonale, e l'asse
    // della cerniera verrebbe storto.
    // Vertici doppi (stesso punto, normali o UV diverse) contati una volta sola
    const unici = [...new Map(punti.map((p) => [`${p.x.toFixed(4)},${p.z.toFixed(4)}`, p])).values()];
    const m = { x: 0, z: 0 };
    for (const p of unici) { m.x += p.x / unici.length; m.z += p.z / unici.length; }
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of unici) {
      sxx += (p.x - m.x) ** 2;
      szz += (p.z - m.z) ** 2;
      sxz += (p.x - m.x) * (p.z - m.z);
    }
    let ang = Math.atan2(2 * sxz, sxx - szz) / 2;
    // Ante dritte (entro 2°) agganciate agli assi: la media dei vertici dipende da come
    // SketchUp ha diviso le facce, e due ante uguali risulterebbero leggermente diverse.
    const quarto = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(ang - quarto) < (2 * Math.PI) / 180) ang = quarto;
    const u = { x: Math.cos(ang), z: Math.sin(ang) };
    const w = { x: -u.z, z: u.x };
    // Centro dagli ingombri (metà tra minimo e massimo), non dalla media dei vertici
    const lungo = unici.map((p) => p.x * u.x + p.z * u.z);
    const largo = unici.map((p) => p.x * w.x + p.z * w.z);
    const [pMin, pMax] = [Math.min(...lungo), Math.max(...lungo)];
    const qMezzo = (Math.min(...largo) + Math.max(...largo)) / 2;
    const pMezzo = (pMin + pMax) / 2;
    const centro = { x: u.x * pMezzo + w.x * qMezzo, z: u.z * pMezzo + w.z * qMezzo };
    // Estremità del pannello, sulla sua linea di mezzo
    const mezzaLunghezza = (pMax - pMin) / 2;
    const e1 = { x: centro.x - u.x * mezzaLunghezza, z: centro.z - u.z * mezzaLunghezza };
    const e2 = { x: centro.x + u.x * mezzaLunghezza, z: centro.z + u.z * mezzaLunghezza };
    const yMin = Math.min(...punti.map((p) => p.y));
    const yMax = Math.max(...punti.map((p) => p.y));
    // Normale verso l'esterno del mobile
    let n = { x: -(e2.z - e1.z), z: e2.x - e1.x };
    const l = Math.hypot(n.x, n.z);
    n = { x: n.x / l, z: n.z / l };
    if (mobile && (centro.x - mobile.centro.x) * n.x + (centro.z - mobile.centro.z) * n.z < 0) n = { x: -n.x, z: -n.z };

    let puntoCerniera, asse, segno;
    if (cfg.cerniera === 'alto' || cfg.cerniera === 'basso') {
      // Cerniera orizzontale lungo il bordo alto (o basso) dell'anta
      const r =cfg.cerniera === 'alto' ? -1 : 1; // dove sta il bordo libero rispetto alla cerniera
      puntoCerniera = new Vec(centro.x, cfg.cerniera === 'alto' ? yMax : yMin, centro.z);
      asse = new Vec(u.x, 0, u.z);
      // Verso di rotazione che porta il bordo libero verso l'esterno
      segno = Math.sign(-u.z * r * n.x + u.x * r * n.z) || 1;
    } else {
      // Cerniera verticale: destra di chi guarda l'anta da fuori
      const destra = { x: n.z, z: -n.x };
      const lato = (p) => (p.x - centro.x) * destra.x + (p.z - centro.z) * destra.z;
      const [cerniera, libero] = (cfg.cerniera === 'sx') === (lato(e1) < lato(e2)) ? [e1, e2] : [e2, e1];
      const v = { x: libero.x - cerniera.x, z: libero.z - cerniera.z };
      puntoCerniera = new Vec(cerniera.x, 0, cerniera.z);
      asse = new Vec(0, 1, 0);
      segno = Math.sign(v.z * n.x - v.x * n.z) || 1;
    }

    // Perno sulla cerniera, nello stesso genitore dell'anta; l'anta ci viene agganciata
    // mantenendo la sua posizione. Asse e punto passano in coordinate del genitore.
    const genitore = nodo.parent;
    const aLocale = (v) => genitore.worldToLocal(modello.localToWorld(v.clone()));
    // Un gruppo vuoto (se l'anta è una mesh singola, si usa il tipo del genitore)
    const perno = new (nodo.isMesh ? genitore : nodo).constructor();
    perno.name = `perno-${nodo.name}`;
    perno.position.copy(aLocale(puntoCerniera));
    genitore.add(perno);
    perno.updateMatrixWorld(true);
    perno.attach(nodo);
    const asseLocale = aLocale(asse).sub(aLocale(new Vec(0, 0, 0))).normalize();
    const gradi = cfg.angolo || (asse.y ? 95 : 90);
    risultato.ante.push({ nome: cfg.nome, perno, asse: asseLocale, angolo: (segno * gradi * Math.PI) / 180, valore: 0 });
  }

  const cc = ANIMAZIONI.cassetti;
  if (cc) {
    const assi = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    const [dx, dy, dz] = assi[cc.verso] || assi['+z'];
    const corsa = cc.corsa || 0.25;
    const lista = [];
    for (const nome of cc.nomi || []) {
      const nodo = trovaGruppo(modello, nome);
      if (!nodo) {
        console.warn(`Cassetto "${nome}" non trovato nel modello`);
        continue;
      }
      // Spostamento in coordinate del genitore del cassetto
      const a = nodo.parent.worldToLocal(modello.localToWorld(new Vec(0, 0, 0)));
      const b = nodo.parent.worldToLocal(modello.localToWorld(new Vec(dx * corsa, dy, dz * corsa)));
      lista.push({ nodo, inizio: nodo.position.clone(), spostamento: b.sub(a) });
    }
    if (lista.length) {
      const anta = risultato.ante.find((a) => a.nome === cc.anta) || null;
      risultato.cassetti = { lista, anta, valore: 0 };
    }
  }

  if (risultato.ante.length) bottoneAnte?.removeAttribute('hidden');
  if (risultato.cassetti) bottoneCassetti?.removeAttribute('hidden');
  return risultato.ante.length || risultato.cassetti ? risultato : null;
}

function applicaStato() {
  if (!mobili) return;
  for (const a of mobili.ante) a.perno.quaternion.setFromAxisAngle(a.asse, a.angolo * a.valore);
  const c = mobili.cassetti;
  if (c) {
    // I cassetti escono uno dopo l'altro, nell'ordine dell'elenco
    const n = c.lista.length;
    c.lista.forEach((k, i) => {
      const t = Math.min(1, Math.max(0, c.valore * (1 + 0.3 * (n - 1)) - 0.3 * i));
      k.nodo.position.copy(k.inizio).addScaledVector(k.spostamento, t);
    });
  }
  mobili.scena.queueRender();
}

// Porta il "valore" di ciascuna parte a "destinazione" con un movimento morbido.
function anima(parti, destinazione, durata = 900) {
  const da = parti.map((p) => p.valore);
  if (parti.every((p) => p.valore === destinazione)) return Promise.resolve();
  return new Promise((fatto) => {
    const inizio = performance.now();
    const passo = (ora) => {
      const t = Math.min(1, (ora - inizio) / durata);
      const morbido = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      parti.forEach((p, i) => (p.valore = da[i] + (destinazione - da[i]) * morbido));
      applicaStato();
      if (t < 1) requestAnimationFrame(passo);
      else fatto();
    };
    requestAnimationFrame(passo);
  });
}

const anteAperte = () => mobili.ante.length > 0 && mobili.ante.every((a) => a.valore >= 1);

function aggiornaBottoni() {
  if (!mobili) return;
  const plurale = mobili.ante.length > 1;
  if (bottoneAnte) bottoneAnte.textContent = `${anteAperte() ? 'Chiudi' : 'Apri'} ${plurale ? 'ante' : 'anta'}`;
  if (bottoneCassetti) bottoneCassetti.textContent = `${mobili.cassetti?.valore >= 1 ? 'Chiudi' : 'Apri'} cassetti`;
}

let inMovimento = false;
async function sequenza(passi) {
  if (inMovimento || !mobili) return;
  inMovimento = true;
  for (const [parti, valore] of passi) await anima(parti, valore);
  inMovimento = false;
  aggiornaBottoni();
}

// I cassetti passano davanti alla loro anta: si apre prima l'anta, si chiudono prima i cassetti.
bottoneAnte?.addEventListener('click', () => {
  const cassetti = mobili?.cassetti ? [mobili.cassetti] : [];
  sequenza(anteAperte() ? [[cassetti, 0], [mobili.ante, 0]] : [[mobili.ante, 1]]);
});
bottoneCassetti?.addEventListener('click', () => {
  const c = mobili?.cassetti;
  if (!c) return;
  sequenza(c.valore >= 1 ? [[[c], 0]] : [[c.anta ? [c.anta] : [], 1], [[c], 1]]);
});

// ---------- Specchi che riflettono davvero ----------
// Riflesso planare, la stessa tecnica del Reflector di three.js: a ogni fotogramma la scena
// viene disegnata una seconda volta da una camera speculare rispetto allo specchio, e
// l'immagine finisce sullo specchio. model-viewer non espone le classi di three.js e una
// seconda copia della libreria non funziona con il suo renderer: le classi si prendono dagli
// oggetti che model-viewer ha già (camera, buffer e materiale dell'ombra). Se mancano, lo
// specchio resta metallo lucido (vedi analizzaModello).

const SPECCHIO_VERTEX = `
uniform mat4 textureMatrix;
varying vec4 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = textureMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SPECCHIO_FRAGMENT = `
uniform vec3 color;
uniform sampler2D tDiffuse;
varying vec4 vUv;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 base = texture2DProj(tDiffuse, vUv);
  gl_FragColor = vec4(base.rgb * color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function creaSpecchi(scena) {
  const modello = scena._model;
  const sorgenti = [];
  modello.traverse((o) => {
    if (o.isMesh && [].concat(o.material).some((m) => m.userData.specchio)) sorgenti.push(o);
  });
  if (!sorgenti.length) return;

  // In three.js i marcatori isWebGLRenderTarget, isShaderMaterial… stanno sugli oggetti, non sulle classi.
  const rtOmbra = scena.shadow?.renderTarget;
  const shaderOmbra = scena.shadow?.horizontalBlurMaterial;
  const RenderTarget = rtOmbra?.isWebGLRenderTarget && rtOmbra.constructor;
  const Shader = shaderOmbra?.isShaderMaterial && shaderOmbra.constructor;
  const Vec4 = rtOmbra?.scissor?.isVector4 && rtOmbra.scissor.constructor;
  const Camera = scena.camera?.isPerspectiveCamera && scena.camera.constructor;
  if (!RenderTarget || !Shader || !Vec4 || !Camera) {
    console.info('Specchio: riflesso vero non disponibile con questa versione di model-viewer, resta lucido.');
    return;
  }
  const Vec3 = scena.boundingBox.min.constructor;
  const Mat4 = modello.matrixWorld.constructor;
  const Mesh = sorgenti[0].constructor;
  const Geometria = sorgenti[0].geometry.constructor;
  // Le posizioni del modello ottimizzato sono "interlacciate" (altro tipo di contenitore):
  // gli indici invece usano il contenitore semplice, quello che serve.
  const indici = sorgenti[0].geometry.index;
  const Attributo = indici?.isBufferAttribute && !indici.isInterleavedBufferAttribute && indici.constructor;
  if (!Attributo) {
    console.info('Specchio: riflesso vero non disponibile con questo modello, resta lucido.');
    return;
  }
  const Colore = [].concat(sorgenti[0].material)[0].color.constructor;

  modello.updateMatrixWorld(true);
  const inversa = new Mat4().copy(modello.matrixWorld).invert();
  const lato = () => Math.min(2048, Math.round(mv.clientWidth * Math.min(devicePixelRatio, 2)));
  const alto = () => Math.min(2048, Math.round(mv.clientHeight * Math.min(devicePixelRatio, 2)));

  for (const sorgente of sorgenti) {
    // Ingombro dello specchio in coordinate del modello: l'asse più sottile è la normale.
    const rel = new Mat4().multiplyMatrices(inversa, sorgente.matrixWorld);
    const pos = sorgente.geometry.attributes.position;
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pos.count; i++) {
      const p = new Vec3().fromBufferAttribute(pos, i).applyMatrix4(rel);
      min.min(p);
      max.max(p);
    }
    const dim = new Vec3().subVectors(max, min);
    const centro = new Vec3().addVectors(min, max).multiplyScalar(0.5);
    const asse = ['x', 'y', 'z'].reduce((a, b) => (dim[b] < dim[a] ? b : a));
    // Verso: dalla parte del fronte del mobile; per specchi di fianco, verso il centro del mobile
    let segno = asse === 'y' ? 1 : Math.sign(FRONTE.n[asse] || 0);
    if (!segno) segno = Math.sign((mobile?.centro[asse] ?? centro[asse]) - centro[asse]) || 1;
    const normale = new Vec3();
    normale[asse] = segno;
    const [larghezza, altezza] = asse === 'x' ? [dim.z, dim.y] : asse === 'z' ? [dim.x, dim.y] : [dim.x, dim.z];
    centro[asse] += segno * (dim[asse] / 2 + 0.001); // 1 mm davanti alla superficie

    const geometria = new Geometria();
    const [w, h] = [larghezza / 2, altezza / 2];
    geometria.setAttribute('position', new Attributo(new Float32Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0]), 3));
    geometria.setIndex([0, 1, 2, 0, 2, 3]);

    const bersaglio = new RenderTarget(lato(), alto(), { samples: 4, type: 1016 /* HalfFloatType */ });
    const colore = new Colore();
    colore.setRGB(0.72, 0.74, 0.75); // leggermente scuro, con una punta fredda come il vetro
    const materiale = new Shader({
      name: 'specchio',
      uniforms: { color: { value: colore }, tDiffuse: { value: bersaglio.texture }, textureMatrix: { value: new Mat4() } },
      vertexShader: SPECCHIO_VERTEX,
      fragmentShader: SPECCHIO_FRAGMENT,
    });
    const specchio = new Mesh(geometria, materiale);
    specchio.name = 'specchio-riflettente';
    specchio.position.copy(centro);
    modello.add(specchio);
    specchio.updateMatrixWorld(true);
    specchio.lookAt(modello.localToWorld(centro.clone().add(normale)));
    specchio.raycast = nessunRaycast;

    const camera = new Camera();
    const [posSpecchio, posCamera, n, vista, obiettivo, mira] = [0, 0, 0, 0, 0, 0].map(() => new Vec3());
    const rotazione = new Mat4();
    const piano = new Vec4();
    const q = new Vec4();
    const matrice = materiale.uniforms.textureMatrix.value;

    specchio.onBeforeRender = (renderer, scena3, cam) => {
      posSpecchio.setFromMatrixPosition(specchio.matrixWorld);
      posCamera.setFromMatrixPosition(cam.matrixWorld);
      rotazione.extractRotation(specchio.matrixWorld);
      n.set(0, 0, 1).applyMatrix4(rotazione);
      vista.subVectors(posSpecchio, posCamera);
      if (vista.dot(n) > 0) return; // camera dietro lo specchio

      // Camera speculare
      vista.reflect(n).negate().add(posSpecchio);
      rotazione.extractRotation(cam.matrixWorld);
      mira.set(0, 0, -1).applyMatrix4(rotazione).add(posCamera);
      obiettivo.subVectors(posSpecchio, mira).reflect(n).negate().add(posSpecchio);
      camera.position.copy(vista);
      camera.up.set(0, 1, 0).applyMatrix4(rotazione).reflect(n);
      camera.lookAt(obiettivo);
      camera.far = cam.far;
      camera.updateMatrixWorld();
      camera.projectionMatrix.copy(cam.projectionMatrix);

      // Dalle coordinate dello specchio a quelle dell'immagine riflessa
      matrice.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      matrice.multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse).multiply(specchio.matrixWorld);

      // Piano di taglio obliquo: niente di quello che sta dietro lo specchio finisce nel riflesso
      const nv = n.clone().transformDirection(camera.matrixWorldInverse);
      const pv = posSpecchio.clone().applyMatrix4(camera.matrixWorldInverse);
      piano.set(nv.x, nv.y, nv.z, -nv.dot(pv));
      const e = camera.projectionMatrix.elements;
      q.set((Math.sign(piano.x) + e[8]) / e[0], (Math.sign(piano.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      piano.multiplyScalar(2 / piano.dot(q));
      e[2] = piano.x;
      e[6] = piano.y;
      e[10] = piano.z + 1;
      e[14] = piano.w;

      // Secondo rendering, nel buffer dello specchio
      specchio.visible = false;
      const precedente = renderer.getRenderTarget();
      const xr = renderer.xr.enabled;
      const ombre = renderer.shadowMap.autoUpdate;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(bersaglio);
      renderer.state.buffers.depth.setMask(true);
      if (renderer.autoClear === false) renderer.clear();
      renderer.render(scena3, camera);
      renderer.xr.enabled = xr;
      renderer.shadowMap.autoUpdate = ombre;
      renderer.setRenderTarget(precedente);
      if (cam.viewport !== undefined) renderer.state.viewport(cam.viewport);
      specchio.visible = true;
    };

    window.addEventListener('resize', () => bersaglio.setSize(lato(), alto()));
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => bersaglio.setSize(lato(), alto())));
  }
  scena.queueRender();
}

// ---------- Schermo intero ----------
// Visualizzatore e comandi insieme (#area). Sull'iPhone Safari non lo consente: il bottone resta nascosto.

const area = document.querySelector('#area');
const bottoneSchermo = document.querySelector('#schermo-intero');
const inSchermoIntero = () => document.fullscreenElement || document.webkitFullscreenElement;

if (area && bottoneSchermo && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
  bottoneSchermo.removeAttribute('hidden');
  bottoneSchermo.addEventListener('click', () => {
    if (inSchermoIntero()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (area.requestFullscreen || area.webkitRequestFullscreen).call(area);
  });
  const cambio = () => {
    bottoneSchermo.textContent = inSchermoIntero() ? 'Esci da schermo intero' : 'Schermo intero';
    requestAnimationFrame(() => disegnaQuote());
  };
  document.addEventListener('fullscreenchange', cambio);
  document.addEventListener('webkitfullscreenchange', cambio);
}

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

// Lato mostrato da "Lato" e "Prospettiva": destro (predefinito) o sinistro di chi guarda
// il fronte (window.LATO = "sinistra" nella pagina).
const SPECCHIO = window.LATO === 'sinistra' ? -1 : 1;

function angoliVista(nome) {
  const [theta, phi] = VISTE[nome];
  return `${theta * SPECCHIO + FRONTE.ang}deg ${phi}deg`;
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
    chiudiNote();
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
let notaAperta = null;

function chiudiNote() {
  notaAperta = null;
  mv.querySelectorAll('.nota').forEach((el) => el.classList.remove('aperta'));
  document.querySelectorAll('#elenco-note button').forEach((el) => el.classList.remove('attiva'));
}

// Un clic apre la nota e ci porta la camera; un secondo clic sulla stessa nota la chiude.
function apriNota(indice) {
  if (notaAperta === indice) {
    chiudiNote();
    return;
  }
  notaAperta = indice;
  mv.querySelectorAll('.nota').forEach((el, i) => el.classList.toggle('aperta', i === indice));
  document.querySelectorAll('#elenco-note button').forEach((el, i) => el.classList.toggle('attiva', i === indice));
  const n = NOTE[indice];
  vaiA({ target: n.position, orbit: n.orbit });
  segnaVista(null);
}

// Toccando o trascinando il modello fuori dalle note, il fumetto si chiude.
mv.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('.nota')) chiudiNote();
});

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

function creaHotspot(nome, classe, posizione = '0m 0m 0m') {
  const el = document.createElement('div');
  el.slot = `hotspot-${nome}`;
  el.className = classe;
  el.dataset.position = posizione;
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
const SVG = 'http://www.w3.org/2000/svg';

// Frecce alle estremità delle linee di quota, come in SketchUp.
const defs = document.createElementNS(SVG, 'defs');
defs.innerHTML =
  '<marker id="freccia" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
  '<path d="M0,0 L10,5 L0,10 z"/></marker>';
linee.prepend(defs);

// Linee di quota presenti: le tre automatiche più quelle scritte nella pagina.
let nomiLinee = [...QUOTE];

// Quote scritte nella pagina (window.QUOTE_MANUALI): come una quota di SketchUp,
// due punti in metri nelle coordinate del modello e il testo da mostrare.
const QUOTE_MANUALI = Array.isArray(window.QUOTE_MANUALI) ? window.QUOTE_MANUALI : [];
QUOTE_MANUALI.forEach((q, i) => {
  const nome = `m${i}`;
  const pos = (v) => `${v[0]}m ${v[1]}m ${v[2]}m`;
  creaHotspot(`quota-${nome}-a`, 'quota-punto', pos(q.da));
  creaHotspot(`quota-${nome}-b`, 'quota-punto', pos(q.a));
  creaHotspot(`quota-${nome}`, 'quota-etichetta', pos(q.da.map((v, k) => (v + q.a[k]) / 2))).textContent = q.testo;
  const linea = document.createElementNS(SVG, 'line');
  linea.dataset.quota = nome;
  linee.appendChild(linea);
  nomiLinee.push(nome);
});

// Con le misure scritte a mano (window.INGOMBRO) le quote automatiche non servono.
function togliQuoteAutomatiche() {
  for (const nome of QUOTE) {
    for (const suffisso of ['-a', '-b', '']) mv.querySelector(`[slot="hotspot-quota-${nome}${suffisso}"]`)?.remove();
    linee.querySelector(`[data-quota="${nome}"]`)?.remove();
  }
  nomiLinee = nomiLinee.filter((n) => !QUOTE.includes(n));
}

function cm(metri) {
  const v = Math.round(metri * 1000) / 10;
  return `${String(v).replace('.', ',')} cm`;
}

function xyz(v) {
  return `${v.x}m ${v.y}m ${v.z}m`;
}

function disegnaQuote() {
  for (const nome of nomiLinee) {
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

  contorno = analisi?.pezziContorno || [];
  if (contorno.length) mv.setAttribute('ar-modes', 'webxr quick-look'); // Scene Viewer mostrerebbe tutto il file

  if (analisi?.pezziStanza.length) {
    stanza = { scena: analisi.scena, pezzi: analisi.pezziStanza };
    sceltaStanza?.closest('label')?.removeAttribute('hidden');
    mostraStanza(sceltaStanza?.value || 'trasparente');
    // Scene Viewer (Android) carica il file così com'è, stanza compresa: si usa WebXR.
    mv.setAttribute('ar-modes', 'webxr quick-look');
    // Sotto il pavimento non c'è niente da vedere.
    mv.maxCameraOrbit = 'auto 90deg 300%';
    // L'ombra automatica di model-viewer cade alla quota del pavimento della stanza:
    // le due superfici coincidono e il pavimento si riempie di strisce. C'è già il pavimento.
    mv.shadowIntensity = 0;
  }

  if (analisi && ANIMAZIONI) {
    mobili = preparaAnimazioni(analisi.scena);
    aggiornaBottoni();
  }
  if (analisi) {
    // Se il riflesso non riesce, lo specchio resta lucido e il resto della pagina funziona.
    try {
      creaSpecchi(analisi.scena);
    } catch (e) {
      console.warn('Specchio: riflesso vero non riuscito, resta lucido.', e);
    }
  }

  if (typeof window.INGOMBRO === 'string') {
    // Misure scritte nella pagina: per mobili non rettangolari, o non allineati agli assi,
    // il rettangolo calcolato sarebbe più grande del vero. Niente linee di quota 3D.
    const ingombro = document.querySelector('#ingombro');
    if (ingombro) ingombro.textContent = `Ingombro: ${window.INGOMBRO}`;
    togliQuoteAutomatiche();
    if (!QUOTE_MANUALI.length) interruttoreQuote?.closest('label')?.setAttribute('hidden', '');
  } else {
    piazzaQuote();
  }
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
