# Som da Academia 🎚️

Protótipo funcional de um sistema com dois lados:

- **Painel do staff** (`/staff`) — visualizado num tablet/PC fixo na recepção. Mostra o contexto (bloco de horário) ativo agora, a fila de sugestões dos alunos pra esse contexto, e permite marcar músicas como "tocando" / "tocada" / "remover".
- **Página do aluno** (`/sugerir`) — acessada via QR code pelo celular do aluno. Ele busca uma música no catálogo do Spotify e sugere. Ela entra direto na fila do contexto que está ativo *naquele momento* — o aluno não escolhe o contexto, o sistema decide com base no horário, então não tem como sugerir errado.

## O que já está pronto

- Backend em Node.js + Express, com banco SQLite local (arquivo `gym.db`, criado automaticamente).
- 5 contextos pré-cadastrados (Manhã leve, Treino pesado, Tarde, Treino pesado/noite, Alongamento) — edite os horários deles direto no painel.
- Busca de músicas via Spotify Web API (Client Credentials Flow — **não precisa de conta Premium**, só de um app gratuito no Spotify Developer Dashboard).
- Guardrails automáticos, sem precisar de moderação manual:
  - **Sem conteúdo explícito** — músicas marcadas como "explicit" pelo Spotify nunca aparecem na busca do aluno.
  - **Anti-repetição** — a mesma música não pode ser sugerida de novo no mesmo contexto por 2 horas.
  - **Limite por aluno** — no máximo 3 sugestões por dispositivo a cada 30 minutos (identificado por um cookie, sem precisar de login).
  - **Contexto automático** — a sugestão sempre cai na fila do bloco de horário ativo agora, eliminando o risco de sugestão errada pra hora errada.
- Geração de QR code pra imprimir/exibir perto da recepção.

## O que NÃO está pronto (de propósito)

Você ainda não tem o Spotify Premium da academia, então o sistema **não toca música automaticamente** — ele só organiza a fila. O staff vê a fila no painel, clica em "Abrir" pra abrir a música no app do Spotify (ou no player que vocês já usam) e toca manualmente. Quando você tiver o Premium/Business, dá pra evoluir pra controle automático via Spotify Connect (Authorization Code Flow + Web Playback SDK) — a estrutura do código já foi pensada pra isso encaixar sem reescrever nada.

## Importante: fuso horário

O sistema decide qual contexto está ativo com base no horário do computador onde o servidor está rodando. Se você rodar no próprio PC/tablet da recepção (o cenário recomendado), isso já vem certo automaticamente, porque o relógio do Windows/Mac/Linux já está no fuso de Guarapuava. Só preste atenção nisso se um dia decidir hospedar o backend num servidor na nuvem — nesse caso configure o fuso do servidor pra `America/Sao_Paulo`.

## Como rodar

### 1. Instalar dependências

```bash
npm install
```

### 2. Criar um app no Spotify (gratuito, sem Premium)

1. Acesse https://developer.spotify.com/dashboard e faça login com qualquer conta Spotify.
2. Clique em "Create app".
3. Nome e descrição: o que quiser (ex: "Som da Academia").
4. Redirect URI: pode colocar `http://localhost:3000` (não será usado agora, é só Client Credentials).
5. Depois de criar, copie o **Client ID** e o **Client Secret**.

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` e cole o Client ID e Client Secret. Se for usar em rede local (tablet acessando o PC), ajuste `PUBLIC_URL` pro IP do PC, por exemplo:

```
PUBLIC_URL=http://192.168.0.10:3000
```

### 4. Rodar o servidor

```bash
npm start
```

Acesse:
- Painel do staff: `http://localhost:3000/staff`
- Página do aluno: `http://localhost:3000/sugerir`

O QR code no painel já aponta pra URL configurada em `PUBLIC_URL`.

## Estrutura do projeto

```
server/
  index.js          servidor Express
  db.js             schema do SQLite + seed dos contextos
  contextHelper.js  lógica de "qual contexto está ativo agora"
  spotify.js        busca no catálogo do Spotify (Client Credentials)
  routes/
    contexts.js     listar/editar contextos (horários)
    queue.js        listar fila, criar sugestão (com guardrails), staff atualiza status
    search.js       proxy de busca pro frontend do aluno
    qrcode.js        gera o QR code em SVG
public/
  staff/            painel do staff (HTML/CSS/JS puro, sem build)
  sugerir/          página do aluno
  shared/           tokens de design (cores, tipografia) compartilhados
```

## Próximos passos sugeridos (quando quiser evoluir)

1. **Playback automático**: quando tiver o Premium/Business, implementar Authorization Code Flow + Spotify Connect pra tocar a fila automaticamente no dispositivo da academia, sem o staff precisar abrir o Spotify manualmente.
2. **Dashboard de reclamações**: já que hoje a reclamação é verbal, vale criar um campo simples no painel pra registrar "alguém reclamou de X agora" — em poucas semanas você teria dados reais de quais músicas/horários geram mais atrito, em vez de só percepção.
3. **Playlist local**: hoje a busca é só Spotify. Se quiser incluir os arquivos locais na fila/sugestão, dá pra adicionar um catálogo próprio (nome + artista cadastrados manualmente) como segunda fonte de busca.
4. **Deploy fora da rede local**: se quiser acessar o painel de fora da academia (ex: do celular do gerente em casa), o backend pode subir num serviço como Railway/Render facilmente — é só trocar o SQLite por um banco hospedado se for usar múltiplas instâncias.
