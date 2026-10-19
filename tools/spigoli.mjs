// Aggiunge a un .glb gli spigoli neri, come li disegna SketchUp.
//
//   node tools/spigoli.mjs <ingresso.glb> <uscita.glb> [angolo-gradi]
//
// Per ogni mesh traccia una linea dove due facce si incontrano con un angolo maggiore
// di [angolo-gradi] (predefinito 20) e sui bordi aperti. Le diagonali che dividono una
// faccia piana in triangoli non vengono disegnate. Le linee riusano le posizioni della
// mesh (si aggiungono solo gli indici) e restano nello stesso nodo: gruppi e nomi,
// compresa la "Stanza", non cambiano. Rilanciarlo su un file già trattato non raddoppia.
// Nessuna dipendenza: solo Node.js.

import { readFileSync, writeFileSync } from 'node:fs';

const [ingresso, uscita, angoloArg] = process.argv.slice(2);
if (!ingresso || !uscita) {
  console.error('Uso: node tools/spigoli.mjs <ingresso.glb> <uscita.glb> [angolo-gradi]');
  process.exit(1);
}
const SOGLIA = Math.cos(((Number(angoloArg) || 20) * Math.PI) / 180);
const NOME_MATERIALE = 'spigoli';

// ---------- Lettura del glb ----------

const file = readFileSync(ingresso);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error('Non è un file .glb');
const lungJson = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + lungJson).toString('utf8'));
const inizioBin = 20 + lungJson;
const lungBin = file.readUInt32LE(inizioBin);
if (file.readUInt32LE(inizioBin + 4) !== 0x004e4942) throw new Error('Chunk BIN mancante');
let bin = Buffer.from(file.subarray(inizioBin + 8, inizioBin + 8 + lungBin));

const COMPONENTI = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const DIMENSIONE = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

function leggiAccessor(indice) {
  const acc = gltf.accessors[indice];
  const vista = gltf.bufferViews[acc.bufferView];
  const comp = COMPONENTI[acc.type];
  const dim = DIMENSIONE[acc.componentType];
  const passo = vista.byteStride || comp * dim;
  const base = (vista.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Array(acc.count * comp);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comp; c++) {
      const o = base + i * passo + c * dim;
      out[i * comp + c] =
        acc.componentType === 5126 ? bin.readFloatLE(o)
        : acc.componentType === 5125 ? bin.readUInt32LE(o)
        : acc.componentType === 5123 ? bin.readUInt16LE(o)
        : bin.readUInt8(o);
    }
  }
  return out;
}

// ---------- Materiale delle linee ----------

// Quasi nero (valori lineari: 0.12 diventerebbe un grigio medio, invisibile contro le pareti grigie).
const COLORE = [0.01, 0.01, 0.01, 1];
gltf.materials ??= [];
let materiale = gltf.materials.findIndex((m) => m.name === NOME_MATERIALE);
if (materiale < 0) {
  materiale = gltf.materials.length;
  gltf.materials.push({ name: NOME_MATERIALE });
}
// Anche su un file già trattato: aggiorna il colore.
gltf.materials[materiale].pbrMetallicRoughness = { baseColorFactor: COLORE, metallicFactor: 0, roughnessFactor: 1 };

// ---------- Calcolo degli spigoli ----------

function spigoliDi(prim) {
  const pos = leggiAccessor(prim.attributes.POSITION);
  const nVert = pos.length / 3;
  const idx = prim.indices !== undefined ? leggiAccessor(prim.indices) : [...Array(nVert).keys()];

  // Vertici nello stesso punto (separati per normali o UV) contano come uno solo.
  const chiavi = new Map();
  const unico = new Int32Array(nVert);
  for (let i = 0; i < nVert; i++) {
    const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
    if (!chiavi.has(k)) chiavi.set(k, i);
    unico[i] = chiavi.get(k);
  }

  const lati = new Map(); // "a-b" -> { a, b, normali: [] }
  for (let t = 0; t < idx.length; t += 3) {
    const v = [unico[idx[t]], unico[idx[t + 1]], unico[idx[t + 2]]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const p = v.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n);
    if (l < 1e-12) continue; // triangolo degenere
    const normale = n.map((x) => x / l);
    for (let k = 0; k < 3; k++) {
      const a = Math.min(v[k], v[(k + 1) % 3]);
      const b = Math.max(v[k], v[(k + 1) % 3]);
      const chiave = `${a}-${b}`;
      if (!lati.has(chiave)) lati.set(chiave, { a, b, normali: [] });
      lati.get(chiave).normali.push(normale);
    }
  }

  const linee = [];
  for (const { a, b, normali } of lati.values()) {
    let disegna = normali.length === 1; // bordo aperto
    for (let i = 1; i < normali.length && !disegna; i++) {
      const [n0, ni] = [normali[0], normali[i]];
      // Valore assoluto: una faccia rovesciata non deve creare uno spigolo finto.
      if (Math.abs(n0[0] * ni[0] + n0[1] * ni[1] + n0[2] * ni[2]) < SOGLIA) disegna = true;
    }
    if (disegna) linee.push(a, b);
  }
  return linee;
}

// ---------- Scrittura ----------

function aggiungiIndici(valori) {
  const allineamento = (4 - (bin.length % 4)) % 4;
  const dati = Buffer.alloc(valori.length * 4);
  valori.forEach((v, i) => dati.writeUInt32LE(v, i * 4));
  const offset = bin.length + allineamento;
  bin = Buffer.concat([bin, Buffer.alloc(allineamento), dati]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: dati.length, target: 34963 });
  gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5125, count: valori.length, type: 'SCALAR' });
  return gltf.accessors.length - 1;
}

let totaleLinee = 0;
let mesh = 0;
for (const m of gltf.meshes) {
  if (m.primitives.some((p) => p.material === materiale)) continue; // già trattata
  const nuove = [];
  for (const p of m.primitives) {
    if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
    const linee = spigoliDi(p);
    if (!linee.length) continue;
    nuove.push({ attributes: { POSITION: p.attributes.POSITION }, indices: aggiungiIndici(linee), mode: 1, material: materiale });
    totaleLinee += linee.length / 2;
  }
  if (nuove.length) {
    m.primitives.push(...nuove);
    mesh++;
  }
}

gltf.buffers[0].byteLength = bin.length;
let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);

const testa = Buffer.alloc(12);
testa.writeUInt32LE(0x46546c67, 0);
testa.writeUInt32LE(2, 4);
testa.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const cj = Buffer.alloc(8);
cj.writeUInt32LE(json.length, 0);
cj.writeUInt32LE(0x4e4f534a, 4);
const cb = Buffer.alloc(8);
cb.writeUInt32LE(bin.length, 0);
cb.writeUInt32LE(0x004e4942, 4);
writeFileSync(uscita, Buffer.concat([testa, cj, json, cb, bin]));

console.log(`${totaleLinee} spigoli aggiunti in ${mesh} mesh → ${uscita}`);
