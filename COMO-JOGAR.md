# GRID PROTOCOL — como jogar

Documentação curta. Para mais detalhe, ver `README.md` e `DESIGN-NOTES.md`.

---

## O que é isto

Uma experiência 3D jogada no browser, em primeira pessoa, dentro de um sistema
digital esquecido. Não é um site sobre TRON — é um sítio onde se está *dentro* de
um sistema, a caminhar por ele.

Andas por uma esplanade escura com linhas de luz no chão. Segues a luz até ao
Arcade. Dentro, uma máquina de Light Cycles que é um jogo a sério. Atrás do
Arcade há uma porta discreta que leva a outro sítio, e aí conheces a QUELL.

Tudo o que vês é gerado em runtime — não há um único ficheiro de imagem, modelo
ou som no projecto. Os prédios são geometria, os materiais são GLSL, e a música
é sintetizada pelos osciladores do browser.

---

## Requisitos

- **Node.js 18 ou superior** (verifica com `node --version`)
- Qualquer browser recente com WebGL: Chrome, Edge, Firefox

Não precisas de placa gráfica dedicada. Não há instalação para além das
dependências do projecto. Não há contas, nem chaves de API, nem servidor externo.

---

## Como aceder

A partir da pasta do projecto, corre:

```bash
npm install
npm run dev
```

Depois abre no browser:

```
http://localhost:5173
```

É só isso. Não há segundo passo.

Para parar o servidor: `Ctrl + C` no terminal.

### Se a porta 5173 estiver ocupada

```bash
npm run dev -- --port 3000
```

E abre `http://localhost:3000`.

### Para jogar a versão final em vez da de desenvolvimento

```bash
npm run build
npm run preview
```

Depois abre `http://localhost:4173`.

---

## Comandos disponíveis

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento em `localhost:5173`, com recarga automática. |
| `npm run build` | Verifica os tipos e gera a versão de produção. |
| `npm run preview` | Serve a versão de produção em `localhost:4173`. |
| `npm run typecheck` | Só a verificação de tipos. |

---

## Controlos

| Input | Acção |
|---|---|
| `W A S D` | Andar |
| Rato | Olhar (clica no canvas para capturar o rato) |
| `Shift` | Correr |
| `E` ou `Enter` | Interagir com o objecto iluminado |
| `Q` | Sair de um sector e voltar à Plaza |
| `Esc` | Libertar o rato |
| `Tab` ou `M` | Mapa da rede |
| `O` | Definições |

**Telemóvel:** metade esquerda do ecrã é um joystick virtual, metade direita é
arrastar para olhar, com um botão de interacção do lado direito.

---

## Os primeiros trinta segundos

- A introdução é curta e salta-se com `Esc` ou no botão **SKIP**.
- O primeiro clique também desbloqueia o áudio do browser — não há autoplay sem
  um gesto, é uma regra do browser e não um bug.
- A luz no chão é o caminho. Aponta para o Arcade, a uns 150 metros. Não precisas
  de ler nada para saber para onde ir.

O Light Cycle só abre depois de o ligares. A porta de trás do Arcade só abre se
ganhares o jogo.

---

## Definições

`O`, ou o botão discreto no canto. Dentro:

- **VOLUME** / **MUTE** — som
- **QUALITY** — AUTO, HIGH, MEDIUM, LOW. AUTO mede o desempenho e desce sozinho
  se o computador não aguentar
- **REDUCED MOTION** — SYSTEM segue o sistema operativo, REDUCE força o modo
  reduzido, FULL força a versão cinematográfica
- **HEAD BOB**, **INVERT Y**, **REDUCE FLASHING**
- **DELETE SAVE** — apaga todo o progresso

---

## Os teus dados

O progresso fica guardado **só neste browser**, em `localStorage`, nas chaves
`grid-protocol.save.v1` e `grid-protocol.settings.v1`. Nada mais.

Para apagar: **Definições → DELETE SAVE**, e confirmar. Limpa as chaves e
recarrega o site.

O projecto **não** acede aos teus ficheiros, pastas ou documentos, **não**
executa programas nem comandos, **não** altera definições do Windows, e **não**
faz pedidos de rede em runtime. Os terminais e ficheiros que vês no jogo são
conteúdo fictício desenhado dentro do ecrã.

---

## Se algo correr mal

**Ecrã preto, ou o jogo muito lento.**
A maior parte das máquinas com WebGL lê bem. Se ficar escuro, desliga
`prefers-reduced-motion` do sistema e recarrega.

**O rato não se move.**
Tens de clicar no canvas primeiro para o browser capturar o rato. `Esc`
liberta-o.

**Sem som.**
O browser não deixa tocar áudio sem um clique. Clica em qualquer sítio.

**A porta dos Light Cycles não abre.**
Precisas de interagir com a máquina (E) para a ligar. A porta de trás do Arcade
só responde depois de ganhares uma partida.

**Erro ao instalar.**
Apaga `node_modules` e a pasta `package-lock.json`, e corre `npm install` de
novo. Requer Node 18+.