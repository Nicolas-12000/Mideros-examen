# Examen-mideros

Consola de vigilancia sísmica en **Next.js** con:

- **Workers dedicados** por partición de estaciones (`navigator.hardwareConcurrency`)
- Historial de 10 minutos en **SharedArrayBuffer** + `TypedArray` circular por canal
- Sincronización lector/escritor con **Atomics** (lectura no bloqueante, detección de lectura invalidada)
- Render en `requestAnimationFrame` con **diezmado min/máx por píxel** para 27 trazas
- Instrumentación en vivo de **INP** (`event timing`) y **long tasks** (`PerformanceObserver`)
- Confirmación de evento multi-estación (>=4 estaciones) en ventana de 6 s
- Exportación CSV ±90 s de 27 canales en **Worker** (sin bloquear UI)
- Encabezados **COOP/COEP** para `crossOriginIsolated === true`

## Ejecutar

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`.

## Verificación rápida de RT

- RT-1: `src/workers/signal.worker.ts` contiene detección y procesamiento de señal
- RT-2/RT-3: `SharedArrayBuffer` + `Atomics` en `src/app/page.tsx` y worker
- RT-4: botón **"Medir copy vs transferible"** en UI
- RT-5: `next.config.ts` agrega COOP/COEP
- RT-6: dibujo exclusivamente en `requestAnimationFrame`
- RT-7: `PerformanceObserver` para `event` y `longtask`
- RT-8: no se encadena trabajo de rezago con microtareas en hilo principal
- RT-9: listo para despliegue (requiere hosting de Next.js)
