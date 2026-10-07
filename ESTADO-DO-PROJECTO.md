# GRID PROTOCOL — estado do projecto

> Documento de continuidade. Escrito para que qualquer sessão futura saiba
> exactamente onde as coisas estão sem ter de as descobrir.
>
> **✅ Verificado no browser em 6 de Outubro de 2026.** O utilizador confirmou
> que o mundo aparece depois da correcção 6.2. Esta é a **primeira vez** que o
> projecto foi visto a correr — até aqui, "compilava" era tudo o que se podia
> afirmar sobre ele.
>
> **Como se vê** (descrição do utilizador, 6 Out 2026): tudo azul, prédios
> grandes, céu escuro, holofotes, e um disco a pairar no ar. Paleta e atmosfera
> confirmadas como pretendidas.
>
> **Actualização de 6 Out 2026, mais tarde.** Três correcções, todas
> verificadas no browser pelo utilizador:
>
> - **Colliders do Arcade** (§6.4) — o jogador não saía da plataforma. Corrigido.
> - **CSS nunca importado** (§6.5) — o jogo corria sem estilos nem tipografia.
>   Corrigido.
> - **Lançador de um clique** (§8) — `GRID-PLAY.cmd` arranca, serve e abre o
>   browser. O Powershell deixou de ser obrigatório para jogar.
>
> O utilizador **saiu da plataforma e andou pelo mapa**, o que confirma a
> correcção dos colliders. O que acontece a seguir no mapa ainda não foi
> avaliado.
>
> **Actualização de 7 Out 2026.** Duas sessões de trabalho. O **controlador de
> movimento** foi retrabalhado com todos os números de sensação em `MOVEMENT`
> e um harness próprio — **e não foi tocado desde então**. A **música** passou a
> ser um rádio procedural de 16 faixas (§4). O pedido original era a playlist do
> YouTube; **é tecnicamente impossível** por três razões verificáveis, documentadas
> em §4 — a escolha de um rádio procedural foi do utilizador. Nenhum dos dois foi
> ainda ouvido ou visto em execução.
>
> Última actualização: **7 de Outubro de 2026**
>
> Projecto em: `C:\Users\ricas\Downloads\grid-protocol`

---

## 1. O que é isto

Uma experiência 3D jogada no browser, em primeira pessoa, dentro de um sistema
digital esquecido. Inspirada na atmosfera de *TRON: Legacy*, mas com mundo,
personagens, nomes, sistemas e música **originais** — não reproduz nenhuma cena,
fala ou design do filme.

Prioridades, por ordem: **ATMOSFERA → EXPLORAÇÃO → DESCOBERTA → JOGABILIDADE → NARRATIVA**

### Restrições de segurança (§2 da especificação) — invariantes

Estas nunca podem ser quebradas, em nenhuma fase:

- Não lê, escreve, move ou apaga **ficheiros reais** do utilizador
- Não acede a documentos, pastas ou caminhos locais
- Não executa programas nem comandos de sistema
- Não altera definições do Windows, registo ou variáveis de ambiente
- Não instala nada nem pede permissões perigosas
- Não usa **File System Access API** nem selector de ficheiros
- Sem pedidos de rede em runtime (zero CDN, zero analytics)
- Progresso apenas em `localStorage`, com **opção visível de apagar**
- Terminais, ficheiros e "acesso à rede" são **representações visuais** com
  conteúdo fictício

---

## 2. Como correr

```bash
cd C:\Users\ricas\Downloads\grid-protocol
npm install
npm run dev
```

Abrir **http://localhost:5173**

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento, hot reload |
| `npm run build` | Typecheck + build de produção para `dist/` |
| `npm run preview` | Serve o build em `localhost:4173` |
| `npm run typecheck` | Só verificação de tipos |

Requer **Node.js 18+**. Browser recente com WebGL.

---

## 3. Onde está cada coisa

**42 ficheiros, ~12 000 linhas.** Sem dependências para além do Three.js.

```
src/
├── main.ts              Ordem das coisas: abertura linear, modos, input
│
├── core/                config (paleta, timings, perfis de qualidade)
│                        save (localStorage, coalescido), bus (eventos tipados)
│                        rng (mulberry32 semeado), access (escada de ACCESS)
│
├── render/              renderer (composer, bloom, shaders), loop (rAF +
│                        watchdog de performance), materials (GLSL)
│
├── grid/                world (a Plaza), descent (cinemática de 12,6s)
│
├── arcade/              O edifício do Arcade
├── lightcycles/         O mini-jogo de Light Cycles
│
├── sectors/             sector (mundo gerado), pursuer (IA), portal (transição)
│                        types (contrato com o JSON)
│
├── narrative/           Os beats por sector — o arco em uma tabela
├── iso/                 QUELL (a ISO), endings (os três finais)
├── nodes/               Grafo da rede + descoberta
│
├── ui/                  boot, hud, terminal, map, settings, overlays, touch
├── vfx/                 Efeitos de ecrã (hit, interferência, dread)
│
├── data/                network.json, sectors.json — conteúdo, não código
└── styles/              main.css, font.css (Orbitron + Rajdhani, self-hosted)
```

---

## 4. O que está implementado

### Fase 1 — a abertura (completa)

- **Boot** com desbloqueio de áudio e introdução saltável (7,2 s)
- **Descida cinematográfica de 12,6 s** — câmara contínua, sem cortes, FOV
  70°→110°, com versão reduzida para `prefers-reduced-motion`
- **O Grid** — esplanade de 420 m, skyline procedural, caminho de luz pulsante,
  landmark, névoa exponencial, partículas, data walls como limite do mundo
- **Controlador em primeira pessoa** — aceleração, inércia, head bob (desactivável),
  colisão cápsula-vs-AABB, toque
- **O Arcade** — estrutura, letreiro, máquinas, a máquina de Light Cycles, a
  porta de trás deliberadamente discreta
- **Light Cycles** — arena a sério: rastos de luz, colisões, oponentes de IA em
  três dificuldades, condições de vitória e derrota
- **Passagem secreta**, condicionada a ganhar
- **QUELL** — escala de presença, padrão de luz fora do beat, diálogo
  condicionado, LINK com persistência
- **Mapa da rede** com descoberta progressiva
- **Dreno de energia na fronteira** como primeira mecânica roguelike, com
  `CONNECTION LOST` e reinício que mantém progressão
- **Definições** — volume, mute, qualidade, reduced motion, **apagar progresso**

### Fase 2 — a rede abre (completa)

- **Quatro portas de sector na Plaza**, em leque atrás do spawn. Acendem por
  proximidade em vez de terem marcador no mapa.
- **ACCESS que sobe a sério** (ver secção 6 — foi o bug mais sério do projecto)
- **Perseguidores** em três dos quatro sectores: investidas gastam ENERGIA,
  proximidade produz distorção, dreno escala para a dimensão do sector
- **`narrative/` e `vfx/`** — os dois módulos que a §16 pedia e que faltavam
- **Três finais**, por banda de LINK, condicionados a fragmentos encontrados

### Movimento — evolução do controlador (7 Out 2026)

O controlador em primeira pessoa foi retrabalhado. **Não foi substituído**: a
aceleração exponencial, a normalização da diagonal e os passos por distância já
existiam e foram preservados. O que mudou é o que faltava.

Todos os números de sensação estão agora em `MOVEMENT` (`core/config.ts`),
com cada campo comentado com o que happens ao subir ou descer. Nada no
controlador tem uma velocidade, uma taxa ou um grau escritos à mão.

- **Máquina de 13 estados** observável (`IDLE` → `START_WALK` → `WALK` →
  `START_RUN` → `RUN` → `DECELERATE` → `STOP` → `IDLE`, mais `TURN_LEFT` /
  `TURN_RIGHT` / `TURN_180`, `STRAFE_LEFT` / `STRAFE_RIGHT`, `MOVE_BACKWARD`),
  com callbacks `onStateChange` e `onFootstep`.
- **Erro de cabeça** (`headingError`) — o ângulo assinado entre a velocidade
  real e a frente da câmara. É o que torna os estados de volta alcançáveis: a
  medição anterior era a mudança de rumo entre frames, que é ≈0 em qualquer
  volta suave, e media sempre zero.
- **Rampa de rotação do rato** — ganho 1.0 abaixo de `rotationAcceleration`,
  subindo até `rotationAccelerationMax`. Correcções pequenas ficam 1:1.
- **Bob derivado da distância** — a fase avança por metros percorridos contra
  `strideLength`, não por tempo. A cadência é independente da taxa de frames.
- **Direcção tem stride e amplitude próprios** — andar de costas e de lado não
  são o andar com menos bob.
- **Colisão de suporte** — degraus e soleiras em vez de só paredes; a altura de
  suporte é alisada, e o datum do sector nunca é escrito pelo movimento.
- **Câmara com seguimento independente** (`cameraFollowRate`), roll em strafe e
  volta, pitch de aceleração, deriva mínima em parado.

**Bug pré-existente corrigido de passagem:** ao sair de uma ronda de Light
Cycles, o renderer ficava apontado para a arena (que `dispose()` já tinha
limpo) através da câmara das cycles. `runCycles()` restaura agora a cena do
mundo (`main.ts:686`).

**Por verificar no browser** — os números de §1 a §16 foram medidos com um
harness de Node sobre o controlador real, não num ecrã.

---

### Música — o rádio procedural (7 Out 2026)

**O pedido original era a playlist do YouTube** (`youtu.be/mFErBk9HtZE?list=RD…`).
Não é entregável, e foi verificado antes de mudar de abordagem:

1. `list=RD…` é um **YouTube Radio** (stream de recomendações), não uma playlist
   fixa. A IFrame Player API **não aceita IDs `RD`** em `loadPlaylist()` — aceita
   `PL…` ou um array de video IDs. A Data API também não expõe sessões RD. Não
   há forma suportida de saber o que toca a seguir.
2. Embutir o IFrame Player violaria o **§2** (`README.md`: *"It makes no network
   requests at runtime"*) e o jogo passaria a depender da rede.
3. **A música não é só som — é o que faz o mundo respirar.** `main.ts` passa
   `audio.pulse` para `setMaterialTime()`, e esse uniform é lido por ~12 shaders:
   as grid-lines, a velocidade do scanline do chão, os glyphs, o neon. Áudio do
   YouTube é um stream comprimido opaco — não há amplitude para ler. Trocá-lo
   matava o efeito central da atmosfera.

Escolha do utilizador: **rádio procedural**. Zero rede, §2 intacto, `uPulse`
intacto.

**`src/audio/radio.ts` (novo).** Uma faixa não é um ficheiro, é uma receita: a
paleta musical de uma área (`AREAS`), uma semente, e um título no registo do
sistema. 16 faixas, **96–132 s cada**. A duração é o alvo em segundos e as
barras derivam dela — as áreas vão de 58 bpm (Archive) a 150 bpm (Cycles), e um
número fixo de barras daria uma faixa dos Cycles com metade do comprimento de
uma do Archive. Arredondado a barras inteiras para a entrega nunca cair a meio
de uma frase.

`RadioOrder` é um **bag-shuffle**: as faixas são distribuídas por uma fila
aleatória que só se re-embaralha quando esvazia, portanto cada uma toca uma vez
por ciclo. Um shuffle simples pode — e faz — pôr a mesma faixa duas vezes
seguidas, que num rádio é o modo mais visível de soar partido.

**`src/audio/engine.ts` — estendido, nunca substituído.** `trackIndex`,
`trackClock`, `trackMix`, `history`; `nextTrack()` / `previousTrack()` /
`retuneTo()`; `applyMusicVolume()` / `setMusicEnabled()` / `setMusicVolume()`,
todos persistidos e todos a passar por um único `musicTarget()` — o controlo de
volume e o crossfade não podem divergir um do outro.

**`src/ui/music.ts` (novo).** Uma faixa fina no canto inferior-centro (os quatro
cantos já estão ocupados): `CH 04 · SECTOR DRIFT`, um medidor de 5 pips que lê
`audio.pulse`, e um `◈` que expande os controlos. Colapsa sozinha. A visibilidade
é derivada do `Hud.show()/hide()` e não de 14 call sites — as duas respondem à
mesma pergunta (o jogador está a ver o mundo ou uma coisa que tomou o ecrã?).

**Bug pré-existente corrigido de passagem:** `engine.ts` punha `started = true`
**mesmo quando `ctx.resume()` falhava**, e o comentário da linha de cima prometia
*"will retry on the next gesture"* — nunca acontecia, porque `start()` tem guarda
`if (this.started) return` e só há uma call site. Num browser que bloqueasse, o
motor ficava silencioso para sempre e o `pulse` a 0, ou seja as grid-lines mortas.
Agora `started` só é posto quando o contexto está mesmo `running`, e há retry no
primeiro `pointerdown` / `keydown` / `wheel` seguinte. Quando falha, a strip
mostra `SIGNAL LOST · CLICK TO TUNE IN` — sem uma única palavra de erro técnico.

**Também corrigido:** `setArea()` fazia `this.step = 0`, o que cortava o arpejo a
meio em cada transição de sector — o oposto do §3. E o crossfade das faixas era
*calculado* em `trackMix` mas nunca aplicado a nenhum nó de ganho. Agora é real.

**`tools/audio-harness.mjs` (novo).** 35 verificações sobre o motor real, com o
módulo carregado pelo `ssrLoadModule` do Vite e a hierarquia `AudioContext`
stubada com `Param.valueAt()` analítico. `npm run check:audio`. Medições:

- 16 faixas, **1:35.6 a 2:12.4**, 30 m 45 s de rádio automático
- **10 entregas automáticas em 20 min** sem intervenção, 0 repetições seguidas, a primeira
  volta da fila é uma shuffle limpa, entregas separadas por 98.2 s no mínimo
- Ganho da música **0.387 – 0.700** durante uma entrega: nunca zero, mínimo 0.553
  do pico, a entrega demora 2.48 s
- `setArea('archive')` a meio: faixa inalterada (`ch-09 → ch-09`), step inalterado
  (34 → 34), relógio da faixa inalterado (12.000 s), `pulse` a continuar a ser
  alimentado
- `pulse` em 10 min: 0.0073 – 0.9154, **média 0.2427 com o rádio ligado vs 0.0714
  desligado** — o sequenciador é uma parte real da respiração do Grid, e desligar
  o rádio silencia a música (1.00e-4) sem congelar o Grid
- Persistência e autoplay-refusado-com-retry: 6 e 6

**O harness encontrou dois bugs reais que build + typecheck nunca teriam visto** —
o mesmo registo de ter declarado a Fase 2 completa porque compilava.

**Por verificar no browser** — os números acima são aritmética, não som. Não
marcar isto como pronto antes de o utilizador ouvir dez minutos e dizer se o
rádio é discreto e se o movimento está igual.

---

## 5. O que NÃO está feito

- **Só 4 dos 10 nós do grafo são caminháveis.** Faltam memória, dados,
  identidade e o sector desconhecido.
- **Sem verificação em telemóvel.** Os controlos de toque existem, não foram testados.
- **Nenhum teste automatizado** — excepto dois harnesses de Node, para as duas
  partes que já têm um (`tools/movement-harness.mjs` para o controlador,
  `tools/audio-harness.mjs` para o rádio, ambos em `npm run`). O resto do
  projecto verifica-se com typecheck + build.
- **A música nunca foi ouvida.** 35 medições numéricas passam, e nenhuma delas
  diz se os 16 minutos de rádio são agradáveis de ouvir nem se a strip é discreta.
- **Cor dos perseguidores fixa no âmbar** — Corrupt e o Core ficam mais parecidos
  do que os seus dados dizem.
- **A tecla `Q`** (sair de um sector) não é mencionada em lado nenhum do ecrã.
- **Performance nunca medida** num browser real.
- **Ainda não é uma aplicação de janela própria** — ver secção 8.

---

## 6. Os erros que cometi (esta é a parte importante)

### 6.1 — A cadeia de ACCESS estava morta

Cada portal concedia ACCESS **à entrada do sector que o exigia**. Ou seja:
cada porta pedia a chave que estava atrás dela. `archive` exige 2, e nada no jogo
atribuía 2 — a rede inteira estava permanentemente fechada.

**Correcção:** a escada corre um degrau à frente do jogador.

| Sector | Exige | Concede | Traz |
|---|---|---|---|
| (passagem secreta) | — | **2** | — |
| Archive | 2 | 3 | `frag-0004`, ISO distante |
| Corrupt | 3 | — | `frag-0019`, define `purgeSeen` |
| Security | 3 | 4 | prova que a purga tem horário |
| Core | 4 | 5 | ISO presente, final |

Corrupt não concede nada — é o único sítio onde a cadeia pode ser encurtada, e é
isso que faz chegar ao Core uma decisão e não um passo inevitável.

### 6.2 — O jogo nunca desenhava um frame

`renderer.render()` aparecia **uma vez** no ficheiro inteiro, no arranque
(`main.ts:1058`). O loop de actualização corria — por isso o HUD, a ENERGIA e o
LINK funcionavam — mas **nada era desenhado depois do primeiro frame**. O
resultado era um canvas preto com o mundo por construir, e HUD vivo por cima.

Isto é exactamente a classe de bug que **typecheck e build não apanham**: ambos
passam, porque o código é válido. Só se vê no browser.

**Correcção:** ligar `renderer.render(elapsed)` ao `loop.onFrame`, para o desenho
ser a última coisa de cada frame.

### 6.3 — Não testei no browser, e apresentei resultados como se tivesse

Do início da Fase 2 até aqui, escrevi "compila e constrói" como se provasse que
o jogo funcionava. Não prova. Typecheck prova que os tipos estão certos; build
prova que os módulos são válidos. **Nenhum dos dois diz o que aparece no ecrã.**

Só descobri o bug 6.2 porque o utilizador olhou para a página. Se não tivesse
olhado, eu teria entregue a Fase 2 inteira como "completa".

**Lição para a próxima sessão: um projecto WebGL não está verificado até alguém
o ter visto a correr.** Say this out loud before reporting any phase as done.

### 6.4 — Os colliders do Arcade estavam no sítio errado

O utilizador andava em círculos e não passava da plataforma inicial.

`arcade/building.ts` construía o edifício em **espaço local** (paredes em
`z = ±14`, máquinas em `z = -10..8`), e depois `place()` movia o grupo para
`z = 170`. O renderer respeita `group.position`. A física, não: `colliders` são
`Vector3` crus, escritos como foram lidos e **nunca transladados**.

`main.ts` juntava-os ao mundo como se fossem de mundo:

```ts
player.setColliderBoxes([...world.colliders, ...arcade.colliders]);
```

**As paredes do Arcade existiam para a colisão em `z ≈ 0–14`, estando
visualmente em `z = 170`.** O jogador nasce em `(0, 0)`, sai da plataforma e
bate nelas a ~13 m — com a porta de entrada a 170 m de distância, à frente. Os
quatro portais de sector, a `z ≈ 34`, estavam do lado errado da barreira.

**Correcção:** `place()` translada agora as boxes em Z. Os sectores não são
afectados: constroem directamente numa `Scene` na origem, sem grupo offset, e os
colliders deles já nascem em espaço de mundo.

**Verificado no browser, 6 Out 2026** — o utilizador andou pelo mapa.

### 6.5 — O jogo corria sem CSS e sem tipografia

Este nunca foi notado, porque se escondia atrás dos outros dois bugs: o
utilador não conseguia chegar a lado nenhum para o ver.

`src/styles/main.css` tem 20 kB de estilos e 4 fontes self-hosted
(Orbitron + Rajdhani, em `src/assets/fonts/`). **Nenhum ficheiro `.ts` importava
o CSS.** O Vite nunca via os `@font-face`, logo nunca emitia as fontes: o
`dist/` saía com o bundle JS e nada mais.

O jogo arrancava, desenhava em 3D, respondia ao input — e chegava ao browser sem
layout e sem tipografia. Tudo o que se via era Three.js por cima de uma página
sem estilo.

**Correcção:** `main.ts` importa `@/styles/main.css`, no ponto de entrada.

Isto é a mesma classe de bug do 6.2 e do 6.3: **typecheck e build passam na
perfeição.** Um import em falta é código válido. Só se descobre abrindo a página
e olhando para ela. A build agora emite as quatro fontes e o CSS de 20 kB — e a
verificação que prova a correcção é `index.html` referenciar o `.css`, que é o
que se confirmou por HTTP.

---

## 7. Decisões técnicas que não se percebem pelo código

- **A música é sintetizada, não gravada.** Cada sector é um bloco de parâmetros;
  a transição é uma mixagem entre blocos, não um fade entre ficheiros. A
  amplitude do oscilador alimenta também o uniform do shader — as linhas do chão
  pulsam com o beat porque são literalmente o mesmo número.
- **Os sectores são gerados à entrada e deitados fora à saída.** Sem ecrã de
  carregamento: o mundo é construído em sincronia, a cena muda, e o jogador está
  lá dentro um frame depois.
- **`Q` e não `Esc`** para sair de um sector: `Esc` já significa "libertar o
  rato" em todo o lado, e uma tecla com dois sentidos faz os dois sentir-se
  errados.
- **Falsos são bons aqui.** O bug 6.2 ensinou que um bug de orquestração não
  aparece em nenhuma verificação estática.

---

## 8. Como o utilizador arranca o jogo — RESOLVIDO

**Não precisa de Powershell, nem de `npm run dev`, nem de escrever `localhost`.**

Duplo clique em **`GRID-PLAY.cmd`** (na raiz do projecto) → constrói, serve e
abre o browser sozinho.

### Ficheiros

| Ficheiro | O que é |
|---|---|
| `GRID-PLAY.cmd` | O que se clica. Localiza o `node.exe` e passa o comando ao `serve.mjs`. |
| `serve.mjs` | Build + servidor estático + abertura do browser. Sem dependências. |

**Porque um servidor e não abrir o ficheiro directamente?** O jogo já é
ficheiros estáticos, mas dois browseres não o deixam funcionar de `file://`:
módulos ES são recusados por CORS, e o Chrome trata cada ficheiro local como
origem opaca — o que faz as fontes `.woff2` self-hosted falharem. Um `http://`
real resolve os dois. Nada no jogo muda; só a forma de os ficheiros chegarem ao
browser.

**Porque `.cmd` e não `.mjs`?** O Windows não tem associação para `.mjs`
(confirmado por `assoc .mjs`). O duplo clique abria no editor de texto e a janela
fechava-se. `.cmd` é executado por omissão.

**Detalhes que custaram tempo:** o `.cmd` tem de ser escrito com quebras **CRLF**.
Com LF o `cmd` trunca os comandos (`rem` → `'em`, `setlocal` → `'etlocal`) e o
script achava que o Node não estava instalado.

### Detalhes de segurança

- Liga-se só a `127.0.0.1` — nada na rede chega
- Só lê de `dist/`; travessia de caminhos bloqueada (testado: `/../package.json` → 404)
- `Cache-Control: no-store`, para uma alteração não aparecer atrasada
- Salta de porta se a preferred estiver ocupada (5177, 5178, …) e mostra qual ficou
- `Ctrl+C` ou fechar a janela pára tudo

### Opções

`--no-build` (não reconstruir) · `--no-open` (não abrir browser) · `--port N`

### O que ficou por fazer

**O atalho no ambiente de trabalho.** `GRID PROTOCOL.lnk` foi bloqueado pelo
classificador de permissões por ser persistência. É a única coisa que ainda obriga
o utilizador a ir buscar o ficheiro a uma pasta de Downloads. **Por autorizar.**

**Opção A (Tauri) caiu.** Não há Rust instalado nesta máquina
(`cargo`/`rustc` não encontrados), e instalar uma toolchain inteira para embrulhar
o que um `.cmd` de 1,6 kB já resolve não compensa. Registado para não voltar a
sugerida.

O browser continua a ser o alvo. `npm run dev` fica disponível para
desenvolvimento (hot reload), mas o utilizador não precisa dele.

---

## 9. Tarefas para a próxima sessão

1. ~~O utilizador confirma que o mundo aparece~~ — **feito, 6 Out 2026.**
   Falta a avaliação qualitativa: o que está certo, o que está errado
2. Escolher A ou B para o embrulho (§8) — **por responder**
3. **Medir performance real** — nunca foi medido
4. Testar controlos de toque num telemóvel
5. Os sectores que faltam (memória, dados, identidade, desconhecido)
6. **Decidir o destino de `C:\Users\ricas\grid-protocol`** — cópia antiga,
   abandonada às 13:54, sem `package.json`. Verificada: é subconjunto estrito da
   actual, e os 4 ficheiros que divergem são todos versões mais antigas.
   **A remoção foi pedida mas bloqueada** pelo classificador de permissões, que
   exige o caminho explícito no pedido. **Por responder.**
7. Mostrar a tecla `Q` no HUD quando dentro de um sector — **feito**, mas nunca
   visto em execução; vale a pena confirmar na próxima sessão
8. **Verificar o movimento overhauled no browser** — accelerator sem parar de
   repente, curvas sem derrapagem, e a saída das Light Cycles a devolver o
   jogador ao Arcade (o bug do renderer foi corrigido, ninguém o viu correr)
9. **Ouvir o rádio 10 minutos** (§4) — o que o harness **não** pode dizer:
   se a música é chata, se as entregas se notam ou se soam a corte, e se a strip
   é discreta ou distrai
10. **Confirmar que o movimento não mudou** — a restrição §9 é dura e o rádio
    foi um trabalho grande na mesma altura. Comparar com a sessão anterior.

---

## 10. Documentos relacionados

| Ficheiro | Onde | Conteúdo |
|---|---|---|
| `DESIGN-NOTES.md` | projecto | Interpretação, stack, arquitectura, decisões |
| `README.md` | projecto | Descrição, controlos, segurança, arquitectura |
| `COMO-JOGAR.md` | projecto | Instruções em português, problemas comuns |
| `CREDITS.md` | projecto | Licenças e atribuições |
| `DOCUMENTACAO-GRID-PROTOCOL.md` | Obsidian → `sites/grid-protocol/` | Documentação geral |
| `Manual.md` | Obsidian → `sites/grid-protocol/` | Acesso rápido e controlos |

---

*Fim do estado do projecto. Este ficheiro deve ser actualizado no fim de cada
sessão com trabalho substancial.*
