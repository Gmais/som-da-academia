# Som da Academia 🎚️

Sistema com dois lados:

- **Painel do staff** (`/staff`) — visualizado num tablet/PC fixo na recepção. Mostra o contexto (bloco de horário) ativo agora, a fila de sugestões dos alunos pra esse contexto, e permite marcar músicas como "tocando" / "tocada" / "remover".
- **Página do aluno** (`/sugerir`) — acessada via QR code pelo celular do aluno. Ele busca uma música no catálogo do Spotify e sugere. Ela entra direto na fila do contexto que está ativo *naquele momento* — o aluno não escolhe o contexto, o sistema decide com base no horário (fuso de Guarapuava, fixo no código), então não tem como sugerir errado.

## O que já está pronto

- Backend em Node.js + Express, banco **Postgres** (schema criado automaticamente na primeira requisição — não precisa rodar migração manual).
- 5 contextos pré-cadastrados (Manhã leve, Treino pesado, Tarde, Treino pesado/noite, Alongamento) — edite os horários deles direto no painel.
- Busca de músicas via Spotify Web API (Client Credentials Flow — **não precisa de conta Premium**, só de um app gratuito no Spotify Developer Dashboard).
- Guardrails automáticos, sem precisar de moderação manual:
  - **Sem conteúdo explícito** — músicas marcadas como "explicit" pelo Spotify nunca aparecem na busca do aluno.
  - **Anti-repetição** — a mesma música não pode ser sugerida de novo no mesmo contexto por 2 horas.
  - **Limite por aluno** — no máximo 3 sugestões por dispositivo a cada 30 minutos (identificado por um cookie, sem precisar de login).
  - **Contexto automático, com fuso horário fixo** — calcula o horário de Guarapuava explicitamente (`America/Sao_Paulo`), então funciona certo independente de onde o servidor estiver hospedado.
- Geração de QR code pra imprimir/exibir perto da recepção.
- Pronto pra rodar tanto localmente (PC da recepção) quanto como função serverless no Vercel — é o mesmo código nos dois casos.

## Player Oficial e controle remoto

O som é tocado pelo Spotify da academia (conta **Premium** conectada em "Conectar Spotify"). Várias telas do painel podem estar abertas ao mesmo tempo (recepção, sala de treino, celular do professor), mas **só uma toca** — a que estiver com o botão **Player Oficial: ON**.

- Ligar o Player Oficial numa tela desliga automaticamente nas outras. Se a música estava tocando, ela **continua** na nova tela, de onde parou.
- **Qualquer tela** (oficial ou não) controla o som: tocar uma música, pausar/continuar, pular, ajustar o volume, excluir a música (ou a próxima), trocar de lista, ligar o modo aleatório. O servidor guarda o dispositivo do Player Oficial e comanda o Spotify direto, então não depende de qual aba está aberta.
- O **player no topo** (em todas as telas, em qualquer lista aberta) mostra a música tocando, o progresso e a **próxima** — no modo aleatório a "próxima" mostrada é exatamente a que vai tocar.
- **Auto-DJ**: quando a música está para acabar, o Player Oficial passa para a próxima da lista (aleatória ou na ordem). Por padrão a troca acontece nos **últimos 5 segundos** para não ter silêncio entre as músicas (`ANTECIPAR_FIM_MS` no topo de `public/staff/staff.js`; `0` toca até o último segundo). A última música da lista sempre toca até o fim.
- Se a tela oficial for fechada, as outras mostram "Player Oficial offline" e os botões de tocar explicam o que fazer.
- À meia-noite (23:59, horário de Brasília) um cron devolve todas as músicas à fila (`/api/cron/reset-diario`). Defina `CRON_SECRET` para que só o Vercel Cron consiga disparar.

## Estrutura do projeto

```
api/
  index.js          ponto de entrada da função serverless do Vercel (exporta o app Express)
server/
  app.js            configuração do Express (rotas, middlewares) — sem chamar listen
  index.js          launcher local: importa app.js e chama listen (uso: npm start)
  db.js             pool de conexão Postgres + criação/migração automática do schema
  contextHelper.js  a lista fixa "Pedidos de Alunos" (recebe as sugestões do QR code)
  catalog.js        busca de músicas (Deezer, sem conteúdo explícito)
  spotifyAuth.js    login OAuth do Spotify, tokens, busca da música no Spotify, chamadas à Web API
  player.js         núcleo do Player Oficial: quem toca, tocar/pular/pausar/volume, próxima música
  util.js           helpers (concorrência limitada)
  routes/
    contexts.js     listar/criar/editar/excluir/reordenar listas, modo aleatório
    queue.js        listar fila, criar sugestão (com guardrails), staff atualiza status
    player.js       /api/player: estado, controle remoto e posse do Player Oficial
    spotifyAuth.js  conectar conta, token do SDK, criar playlist, importação em massa
    cron.js         reset diário da fila
    search.js       proxy de busca pro frontend do aluno
    qrcode.js       gera o QR code em SVG
public/
  staff/            painel do staff (HTML/CSS/JS puro, sem build) — servido como estático no Vercel
  sugerir/          página do aluno
  shared/           tokens de design (cores, tipografia) compartilhados
vercel.json         rotas: /api/* -> função serverless, /staff e /sugerir -> HTML
```

## Como rodar localmente

### 1. Instalar dependências

```bash
npm install
```

### 2. Criar o banco Postgres

Mais fácil: crie o projeto no Vercel primeiro (próxima seção) e adicione um banco "Vercel Postgres" na aba **Storage** — o Vercel te dá uma `POSTGRES_URL` que funciona tanto em produção quanto localmente (é o mesmo banco, então dá pra testar contra dados reais). Copie esse valor.

### 3. Criar um app no Spotify (gratuito, sem Premium)

1. Acesse https://developer.spotify.com/dashboard e faça login.
2. "Create app" → nome e descrição livres → Redirect URI pode ser `http://localhost:3000`.
3. Copie o **Client ID** e o **Client Secret**.

### 4. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` com `POSTGRES_URL`, `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`.

### 5. Rodar

```bash
npm start
```

Acesse `http://localhost:3000/staff` e `http://localhost:3000/sugerir`.

## Como publicar no GitHub

Você já usa Git no dia a dia, então só os comandos:

```bash
cd som-da-academia
git init
git add .
git commit -m "Primeira versão do Som da Academia"
```

Crie um repositório vazio em https://github.com/new (sem README, sem .gitignore — já tem um aqui), depois:

```bash
git remote add origin https://github.com/SEU_USUARIO/som-da-academia.git
git branch -M main
git push -u origin main
```

## Como publicar no Vercel

1. Em https://vercel.com/new, importe o repositório que você acabou de criar no GitHub.
2. Antes do primeiro deploy (ou depois, em Project Settings → Storage), crie um banco: **Storage → Create Database → Postgres**. O Vercel já injeta `POSTGRES_URL` automaticamente no projeto.
3. Em **Project Settings → Environment Variables**, adicione:
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `PUBLIC_URL` → a URL que o Vercel te der (ex: `https://som-da-academia.vercel.app`), pra o QR code apontar pro lugar certo.
4. Deploy. Pronto — `/staff` e `/sugerir` já funcionam na URL pública, sem precisar de rede local nem do PC da recepção ligado o tempo todo.

Depois do primeiro deploy, qualquer `git push` pra `main` publica uma nova versão automaticamente.

## Próximos passos sugeridos

1. **Proteger o painel com senha/PIN**: hoje `/staff` e `/api/*` (inclusive `/api/spotify/token`) não pedem login — quem souber a URL do painel controla o som.
2. **Dashboard de reclamações**: registrar "alguém reclamou de X agora" no painel — em poucas semanas você teria dados reais de quais músicas/horários geram mais atrito.
3. **Catálogo local**: hoje a busca é só Spotify. Pra incluir os arquivos locais, dá pra adicionar uma segunda fonte de busca com um catálogo cadastrado manualmente.
