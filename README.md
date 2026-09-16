# consola sismo-volcanica

Quiz caso 1. Next.js + workers + SharedArrayBuffer.

## como corre

```
npm install
npm run dev
```

Abrir http://localhost:3000

Si `crossOriginIsolated` sale false, no va el SAB (cabeceras COOP/COEP en `next.config.ts`).

## hilos

- hilo principal: UI, rAF (dibujo min/max), coincidencia de estaciones, INP
- N workers de señal (`hardwareConcurrency - 1`): parsean tramas, STA/LTA, escriben el ring
- 1 worker de export: csv ±90s y el bench copy vs transfer

El generador esta en la pagina (select: normal / desorden / duplicados / perdidas / rafaga).
La rafaga cede con `setTimeout(0)`, no con promesas.

## memoria

27 canales x 120000 muestras x 4 bytes = 12 960 000 bytes el buffer de samples.
Otro igual para seqlock. Heads: 27 x 4.
Total ~26 MB. Si el escritor da la vuelta, el lector ve seq != idx y descarta el pixel.

## notas

STA=40, LTA=1000, on=3.2, off=2.6. LTA se congela en disparo.
Evento confirmado si >=4 estaciones en 6s.
