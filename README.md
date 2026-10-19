# Mobili

Modelli 3D di mobili navigabili via web, pubblicati con GitHub Pages.

- Repository: https://github.com/labprogetti/mobili
- Sito: https://labprogetti.github.io/mobili/

## Struttura

```
index.html                 indice dei mobili
assets/viewer.js           logica comune (viste, quote, note, doppio clic)
assets/viewer.css          stile comune
<mobile>/index.html        pagina del singolo mobile (titolo + window.NOTE)
<mobile>/<nome>-web.glb    modello ottimizzato
_sorgenti/                 .skp e .glb non ottimizzati — ignorata da git, non pubblicata
```

## Aggiungere un mobile

1. Copia la cartella `scrivania-matrimoniale` con un nome nuovo (minuscolo, trattini).
2. In `index.html` della copia cambia `<title>`, `<h1>`, `src`, `alt` e svuota `window.NOTE`.
3. Metti il .glb ottimizzato nella cartella.
4. Aggiungi la voce nell'indice principale.
5. `git add`, `git commit`, `git push`.

## Ottimizzazione del modello

Modello sotto i 5 MB (caso normale per un mobile): ottimizzazione leggera, senza compressioni
speciali, che è la più compatibile con la realtà aumentata.

```
gltf-transform optimize _sorgenti/<nome>.glb <mobile>/<nome>-web.glb --compress false --texture-compress false --texture-size 2048 --simplify false --join false --instance false --palette false --flatten false
```

Sopra i 5 MB: `--compress draco --texture-compress webp` al posto dei due `false`.

Poi gli spigoli neri, come in SketchUp (senza, pannelli e cassetti dello stesso colore si
confondono). Si può usare lo stesso file come ingresso e uscita:

```
node tools/spigoli.mjs <mobile>/<nome>-web.glb <mobile>/<nome>-web.glb
```

Le quattro opzioni `--join/--instance/--palette/--flatten false` servono: con i valori
predefiniti `optimize` unisce le mesh con lo stesso materiale e appiattisce i gruppi, e la
pagina non riuscirebbe più a separare la `Stanza` dal mobile né a misurarlo.

## Da che parte guarda il mobile

Le viste (Fronte, Lato, Pianta) e le quote L/P partono dal fronte del mobile. Se in SketchUp
il fronte non guarda verso la vista *Fronte*, indicalo nella pagina del mobile:

```
window.FRONTE = "+x";   // "+z" (predefinito), "+x", "-z" o "-x"
```

Per capire quale: apri la pagina e premi i bottoni Fronte/Lato; se il fronte vero compare
con "Lato", è `"+x"`.

## Misure scritte a mano

Le quote automatiche misurano il rettangolo che contiene il mobile, allineato agli assi.
Per mobili con fianchi inclinati, ruotati, o con ante e cassetti aperti nel modello, quel
rettangolo è più grande del vero. In quei casi scrivi le misure nella pagina del mobile:

```
window.INGOMBRO = "L 196 × P 50 (max) × H 246 cm";
```

La pagina mostra questo testo e toglie le linee di quota automatiche.

## Quote disegnate a mano

Per mostrare singole misure come le quote di SketchUp (linea con frecce e testo), elencale
nella pagina del mobile con due punti in metri, nelle coordinate del modello:

```
window.QUOTE_MANUALI = [
  { testo: "112,1 cm", da: [-3.08, 0.75, 0.64], a: [-3.08, 0.75, 1.76] },
];
```

I punti si ricavano col doppio clic in modalità `?autore` (il valore `position` della riga
copiata), uno per estremità. Le quote si accendono e spengono con la casella "Quote".

## Stanza di contorno (facoltativa)

Pareti e pavimento aiutano a capire dove va il mobile. In SketchUp mettili in un gruppo
chiamato **`Stanza`** (Informazioni entità → Nome). La pagina lo riconosce da sola:

- quote, ingombro e inquadratura considerano **solo il mobile**;
- la stanza si vede **trasparente** (pavimento pieno), con il menu "Stanza" per renderla
  piena o nasconderla;
- in realtà aumentata si vede solo il mobile (per questo si usa WebXR, non Scene Viewer).

Senza un gruppo `Stanza`, quote e inquadratura valgono per tutto il modello.

## Note cliccabili

Apri la pagina con `?autore` in fondo all'indirizzo, orienta la vista, fai doppio clic
sul punto: la riga viene copiata negli appunti (e stampata in console). Incollala in
`window.NOTE` e sostituisci `…` con il testo.
