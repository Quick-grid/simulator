# GT3 Fase 1.2 — estabilidade em pelotão

**REPROVADO.** Os quatro pelotões passaram aos 30, 60 e 120 s. Aos 180 s, Mônaco, Monza e Spa passaram. Interlagos ainda registrou dois contatos com carros que já tinham completado a corrida, além de um bloqueio de 27,87 s.

## Diagnóstico no checkpoint d01f25b

| Circuito | Primeiro evento fora da pista | Bot | Distância à linha central / limite da zebra |
|---|---:|---:|---:|
| Interlagos | Tick 2698 · 44,97 s | 3 | 14,011 / 14,000 m |
| Mônaco | Tick 2350 · 39,17 s | 0 | 12,004 / 12,000 m |
| Monza | Tick 1964 · 32,73 s | 5 | 14,008 / 14,000 m |
| Spa | Tick 2096 · 34,93 s | 5 | 14,504 / 14,500 m |

Os quatro eventos ultrapassaram a zebra pela medição perpendicular à linha central usada pela física. Em Interlagos, os bots 3 e 5 já haviam se tocado no tick 2018 (33,63 s), com aproximação de 9,27 m/s e penetração de 0,030 m. A telemetria mostra que o bot de trás chegou com velocidade bem maior e aplicou freio total sem espaço suficiente para parar.

Em Mônaco, no tick 780 da reprodução, o bot 0 estava desalinhado em cerca de 1 rad na entrada do hairpin. À medida que perdia velocidade, a física reduzia a capacidade de giro. A previsão lateral da Fase 1.1 também podia rejeitar uma trajetória que mantinha a faixa, e a previsão do tráfego podia mandar o carro da frente frear por um rival ainda atrás. Em Monza e Spa, as primeiras saídas ocorreram após sequências de freio e retomada abaixo de 1 m/s, com deslocamento contínuo para fora da curva. Em Spa também houve acompanhamento lento por falta de espaço à frente.

O planejador agora prevê mudanças laterais com aceleração limitada, preserva a faixa estabelecida diante de carros ainda atrás e prepara curvas fechadas com mais antecedência. Em sequências de curvas de sentidos opostos, reduz o deslocamento para o lado externo. O acompanhamento reserva espaço antes do hairpin para que a espera ocorra no trecho de aproximação. A retomada valida o trajeto em coordenadas do mundo, usa a prioridade longitudinal e mantém o alvo escolhido enquanto ele continuar viável. O controlador continua atuando por acelerador, freio e direção.

## Comparação determinística

Os pelotões usam a semente 17 e a configuração original de duas voltas. Interlagos usa 19 bots no seco, Mônaco 19 no molhado, Monza 10 no seco e Spa 10 no molhado. LEGACY e Fase 1.1 foram executados a partir de um worktree destacado de `d01f25b`. A Fase 1 anterior ao checkpoint não estava disponível como revisão independente.

As colunas de progresso mostram mediana e mínimo em metros. Nas colunas de segurança, a ordem é LEGACY / Fase 1.1 / Fase 1.2. Cada sobreposição é um par de carros sobreposto num tick antes da resolução física. Os ticks fora da pista somam `RUNOFF` e `GRAVEL` por bot.

| Circuito | Duração (s) | LEGACY | Fase 1.1 | Fase 1.2 | Contatos | Sobreposições | Ticks fora | Maior bloqueio 1.1 → 1.2 (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Interlagos | 30 | 1003 / 442 | 1435 / 845 | 1626 / 898 | 234 / 0 / 0 | 9379 / 0 / 0 | 8156 / 0 / 0 | 0,83 → 2,43 |
| Mônaco | 30 | 390 / 69 | 381 / 344 | 436 / 349 | 316 / 0 / 0 | 8934 / 0 / 0 | 11053 / 0 / 0 | 13,55 → 1,62 |
| Monza | 30 | 2207 / 1965 | 1534 / 679 | 1695 / 1390 | 45 / 0 / 0 | 778 / 0 / 0 | 260 / 0 / 0 | 8,20 → 0,60 |
| Spa | 30 | 337 / 254 | 1386 / 305 | 1438 / 975 | 71 / 0 / 0 | 5182 / 0 / 0 | 8868 / 0 / 0 | 13,52 → 1,33 |
| Interlagos | 60 | 2526 / 546 | 2640 / 1478 | 3147 / 2480 | 283 / 1 / 0 | 10232 / 1 / 0 | 17556 / 2132 / 0 | 14,20 → 2,43 |
| Mônaco | 60 | 507 / 105 | 390 / 349 | 1404 / 528 | 577 / 0 / 0 | 14883 / 0 / 0 | 26615 / 2127 / 0 | 43,55 → 1,93 |
| Monza | 60 | 4544 / 3650 | 3380 / 683 | 3605 / 3181 | 56 / 0 / 0 | 930 / 0 / 0 | 1549 / 1504 / 0 | 37,43 → 0,60 |
| Spa | 60 | 334 / 254 | 2971 / 308 | 3092 / 2839 | 214 / 0 / 0 | 11940 / 0 / 0 | 18440 / 2657 / 0 | 43,37 → 1,33 |
| Interlagos | 120 | 5258 / 532 | 6360 / 4731 | 6764 / 5812 | 577 / 1 / 0 | 15866 / 1 / 0 | 42845 / 2917 / 0 | 19,18 → 12,05 |
| Mônaco | 120 | 1579 / 80 | 401 / 365 | 3821 / 2975 | 1002 / 0 / 0 | 22915 / 0 / 0 | 73908 / 4571 / 0 | 99,95 → 1,93 |
| Monza | 120 | 8478 / 4996 | 6425 / 696 | 7705 / 7321 | 67 / 0 / 0 | 1146 / 0 / 0 | 9958 / 3411 / 0 | 44,65 → 0,60 |
| Spa | 120 | 2943 / 253 | 6687 / 308 | 6876 / 6510 | 226 / 0 / 0 | 15732 / 0 / 0 | 43072 / 3302 / 0 | 102,22 → 1,33 |
| Interlagos | 180 | 7070 / 520 | 8644 / 8513 | 8650 / 8605 | 1310 / 2 / 2 | 21710 / 567 / 327 | 76145 / 2917 / 0 | 22,40 → 27,87 |
| Mônaco | 180 | 1737 / 55 | 406 / 381 | 6361 / 5335 | 2037 / 5 / 0 | 32786 / 72 / 0 | 126308 / 6224 / 0 | 159,95 → 1,93 |
| Monza | 180 | 11589 / 4990 | 6430 / 701 | 11573 / 11367 | 519 / 0 / 0 | 2629 / 0 / 0 | 23565 / 4768 / 0 | 73,75 → 1,37 |
| Spa | 180 | 4928 / 253 | 7252 / 308 | 10447 / 9998 | 226 / 0 / 0 | 19332 / 0 / 0 | 65996 / 3302 / 0 | 162,22 → 1,33 |

Os 20 cenários solo com sementes 17 e 83 mantiveram zero ticks fora da pista. Na semente 17, o progresso solo aos 30 s passou de 1927 para 1899 m em Monza seco e de 1245 para 1199 m em Mônaco molhado. O ganho em pelotão veio junto com uma pequena redução no ritmo solo nesses exemplos.

### Falha remanescente em Interlagos

Os contatos dos ticks 10058 (167,63 s, bots 4 e 6) e 10720 (178,67 s, bots 3 e 17) ocorreram com os bots 4 e 3 já classificados como finalizados. Os bots ainda ativos tinham alvo zero e freio total, mas conservavam movimento residual. A maior velocidade de aproximação foi 0,293 m/s e a maior penetração foi aproximadamente 5 mm. O bot 10 ficou bloqueado por 1672 ticks, com rejeições de tráfego e sem trajetória aceita pelo verificador nesse intervalo.

O maior intervalo contínuo em que um bot bloqueado tinha uma proposta aceita de pelo menos 3 m/s foi de 16 ticks (0,27 s). Essa medição cobre as trajetórias avaliadas pelo planejador. A retomada usa uma projeção de 1,6 s, com velocidade dos adversários extrapolada e uma aproximação do giro em baixa velocidade. As rejeições indicam o que esse verificador encontrou, sem estabelecer que inexiste qualquer trajetória fisicamente possível. O bloqueio de Interlagos continua pendente.

## Arquivos alterados

- `src/ai.js` encaminha a distância até a curva fechada do controlador ao planejador.
- `src/ai/gt3Driver.js` prepara a linha de entrada e ajusta a mira para a retomada.
- `src/ai/racePlanner.js` revê a previsão lateral, o acompanhamento, a prioridade e a checagem da retomada.
- `scripts/benchmark_gt3_bots.js` permite comparar durações e worktrees, capturar eventos e verificar a reprodução.
- `scripts/test_gt3_ai.js` cobre a aproximação pela retaguarda e a espera com histerese na entrada de curva.

## Reprodução e verificações

No diretório do simulador, com o worktree de referência ao lado:

```powershell
node scripts/benchmark_gt3_bots.js current --seconds=30,60,120,180 --failures
node scripts/benchmark_gt3_bots.js current --seconds=30,60,120,180 --plain
node scripts/benchmark_gt3_bots.js current --seconds=30,60,120,180 --repo=../simulator-phase11-reference
node scripts/benchmark_gt3_bots.js legacy --seconds=30,60,120,180 --repo=../simulator-phase11-reference
node scripts/benchmark_gt3_bots.js current --pack-only --seconds=60 --trace --failures --repo=../simulator-phase11-reference
node scripts/benchmark_gt3_bots.js current --pack-only --seconds=180 --track=21 --failures
```

As versões 1.1 e 1.2 produziram os mesmos hashes dos 16 pelotões com e sem diagnóstico. O hash cobre a posição, a velocidade, a orientação, os controles aplicados, a pressão de freio, a superfície e o avanço dos checkpoints em cada tick. Os 20 resultados solo também foram idênticos entre as duas modalidades de cada versão.

O JSON registra por bot progresso longitudinal, distância integrada, velocidade média, paradas, bloqueios e motivos, passagens, abortos, contatos e intensidade, sobreposições, saídas, voltas e setores. O modo `--failures` guarda até 24 ticks anteriores e posteriores ao evento, amostrados a cada quatro ticks, com o tick exato da falha. A captura inclui pose, comandos, alvo, alternativas, adversários e estimativa de aderência. O primeiro setor pode começar no grid.

Passaram os 15 testes GT3, as verificações de vácuo, boost e cascalho, recuperação de derrapagem, os testes ML3.5 e ML3.6 e o inventário de lineage ML3. Os SHA-256 dos manifests runtime e histórico foram recalculados e conferem. O build Vite passou com `npm run build -- --configLoader native`, que carrega a configuração diretamente no ambiente Windows.
