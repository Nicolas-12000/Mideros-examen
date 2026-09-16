# Informe caso 1 — consola sismo-volcanica

## 1. Hilos y memoria

```
[generador en main] --postMessage transferible--> [workers señal]
                                                    | escribe SAB (samples + seq + heads)
[main rAF] <--- Atomics.load / seqlock -------------|
[main] --ctrl umbrales--> [workers]
[main] --csv cmd--> [worker export] --csv--> download
```

Particion: estaciones 1..9 repartidas round-robin en `hardwareConcurrency-1` workers.
Main nunca calcula STA/LTA ni arma el csv.

Bytes del ring (RF-5):

- samples: 27 * 120000 * 4 = 12 960 000
- seq: igual = 12 960 000
- heads: 27 * 4 = 108
- total ~ 25.92 MB

Politica wrap: el escritor pisa el slot `idx % 120000`. El lector hace seqlock; si `seq != idx` la muestra se invalido y ese pixel no se dibuja.

## 2. Tabla algoritmica (seccion 5)

| Subproblema | Estructura | Tiempo | Espacio | Por que no otra |
|---|---|---|---|---|
| RF-1 tramas | lista ordenada por (t0, seq) | insert+sort O(n log n) con n<=40 | O(40) acotado | un heap tambien sirve; con n chico la lista alcanza. duplicado: seq < nextSeq se tira |
| RF-2 STA/LTA | ring + suma movil | O(1) por muestra | 40 + 1000 floats | rehacer la media O(k) no aguanta 5400 Hz. cada 8000 samples recalculo la suma (deriva). LTA freeze en trigger |
| RF-3 max | deque monotona | amortizado O(1) | O(ventana) | un heap es O(log n) y hay que borrar vencidos (feo). la deque saca el max del frente |
| RF-4 coincidencia | conteo incremental (inicio/fin) | O(1) por trigger, O(9) al confirmar | O(9) | comparar pares es O(n^2) al pedo con 9 estaciones |
| RF-5 SAB | ring + seqlock Atomics | O(1) r/w | ver bytes | copiar 10 min por postMessage se muere. si el lector llega tarde, seq no coincide |
| RF-6 dibujo | min/max por pixel | O(muestras/px) | O(1) extra | si cojo 1 de cada k me como los pulsos de 1-2 samples |

## 3. Detector

STA 0.2s (40), LTA 5s (1000), on 3.2, off 2.6, amp 5000.
Histéresis + LTA congelada en disparo.
Huecos: si la cola crece y no llega el seq, salto (perdida).
Duplicados: seq ya visto / menor que nextSeq.

## 4. Mediciones (rellenar en la sustentacion)

Correr 1-2 min, arrastrar el canvas, cambiar ventana, poner modo rafaga.

| | antes (todo en main, no lo entregue) | despues |
|---|---|---|
| INP | pegaba | ____ ms (meta <= 200) |
| input delay | | |
| processing | | |
| presentation | | |
| long tasks >50ms | | (meta 0 en main) |
| copy vs transfer 250k float | | copy ____ / tx ____ |

Boton "copy vs transfer" llena la tabla.

## 5. Generador

En el select:

- desorden: shuffle del lote de 250ms
- duplicados: mando la trama 2 veces
- perdidas: salto 1 de cada 17
- rafaga: 12 ciclos seguidos, yield con setTimeout(0) (RT-8, no queueMicrotask)

Cortar flujo / reconectar no mata workers, solo para el interval.
