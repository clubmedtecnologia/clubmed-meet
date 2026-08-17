# Ponte de áudio do paciente — instalação neste fork

Este arquivo documenta a mecânica de build/deploy **deste repo**
(`clubmed-meet`, fork do `jitsi/docker-jitsi-meet`). O `transcricao-bridge.js`
já mora em `custom/web-transcricao/` — é uma **cópia sincronizada** da origem
em `deploy/jitsi/transcricao-bridge.js` do repo `clubmed-web-2024`, que é onde
editar (protocolo `postMessage`, allowlist de origem — documentados no
cabeçalho do próprio arquivo e naquele README). Depois de editar lá, copie o
arquivo para cá antes de buildar.

**Nada aqui altera arquivo original do fork.** `docker-compose.yml`,
`web/Dockerfile`, `Makefile` — intocados. Toda a customização fica dentro de
`custom/`: os dois arquivos de config que já existiam
(`custom/config.js`, `custom/interface_config.js`) e agora também
`custom/docker-compose.custom.yml` + `custom/web-transcricao/`. Isso é
deliberado — como é um fork, um `git pull`/merge do upstream não deveria
nunca colidir com nada nosso.

## Por que COPY na imagem, e não volume

`${CONFIG}/web:/config:Z` (linha 14 do `docker-compose.yml` da raiz) só é
processado para os arquivos que o entrypoint do `web` conhece nominalmente —
`config.js` e `interface_config.js` (ver `location = /config.js` e
`location = /interface_config.js` em `web/rootfs/defaults/meet.conf`). Um
arquivo novo, como `transcricao-bridge.js`, não vira `<script>` automático só
por estar no volume: ele fica servido como estático (`root /usr/share/jitsi-meet`
resolve qualquer arquivo ali), mas **nada no `index.html` carrega ele**.

Cogitamos depender de um include SSI (`<!--#include virtual="title.html" -->`)
que várias instalações de Jitsi têm no `index.html` — o `ssi on` deste
`meet.conf` (linha 22) até suportaria. Mas esse include vem do pacote
`jitsi-meet-web` instalado via apt dentro da imagem, fora deste repo, e não dá
para confirmar sem inspecionar o `index.html` real dentro do container em
produção. Por isso a solução aqui **não depende disso**: `custom/web-transcricao/Dockerfile`
builda uma camada fina que garante a injeção e falha alto (no build) se o
`index.html` não tiver mais `</body>` no formato esperado.

O script entra por `COPY`, não por volume: fica dentro da imagem, versionado
neste repo. Clonar `clubmed-meet` e buildar já é suficiente — não precisa do
`clubmed-web-2024` presente no servidor, nem de um `scp` a cada deploy.

---

## Deploy completo no servidor

Cobre do zero (servidor novo) até o stack no ar já com a ponte de áudio. Se o
seu servidor **já roda** este fork normalmente, pule para o **Passo 5** — os
passos 1 a 4 são o setup padrão do `docker-jitsi-meet`, não são específicos
da ponte de áudio, e você já deve tê-los feito uma vez.

### Passo 1 — Clonar e configurar o `.env`

```bash
git clone <url-deste-repo> clubmed-meet
cd clubmed-meet
cp env.example .env
```

Edite o `.env` — no mínimo:

```bash
CONFIG=~/.jitsi-meet-cfg          # onde as configs/dados persistentes ficam
HTTP_PORT=80                      # ou os que seu reverse proxy/TLS já usa
HTTPS_PORT=443
TZ=America/Sao_Paulo
PUBLIC_URL=https://meet.clubmed.digital
JITSI_IMAGE_VERSION=stable-XXXX   # NUNCA `latest` — upgrade deve ser um evento deliberado, não acidental a cada `pull`
```

TLS/certificado (Let's Encrypt embutido, ou reverse proxy próprio na frente
terminando HTTPS) é decisão de infra já existente do ambiente — este README
não define isso, só assume que `PUBLIC_URL` aponta para o domínio certo.

### Passo 2 — Criar os diretórios de configuração

```bash
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb}
```

Caminhos conferidos em `docker-compose.yml` deste repo (`${CONFIG}/web`,
`${CONFIG}/prosody/config`, `${CONFIG}/prosody/prosody-plugins-custom`,
`${CONFIG}/jicofo`, `${CONFIG}/jvb`, mais `${CONFIG}/storage/*` e
`${CONFIG}/tmp/web-load-test`, que o Compose cria sozinho por serem
subdiretórios). Criar os de cima antes evita problema de permissão na
primeira subida — é o próprio container, não o host, quem deveria ser dono
do que cria depois.

### Passo 3 — Gerar as senhas internas

```bash
./gen-passwords.sh
```

Preenche `JICOFO_AUTH_PASSWORD`, `JVB_AUTH_PASSWORD` etc. no `.env` — a
comunicação interna prosody↔jicofo↔jvb, não tem relação com a ponte de áudio.

### Passo 4 — Colocar `custom/config.js` e `custom/interface_config.js` no lugar

```bash
cp custom/config.js custom/interface_config.js "$CONFIG/web/"
```

Suas customizações de UI/config de sempre — nada mudou aqui.

### Passo 5 — Pré-condição da ponte de áudio (2 min)

Confirma que a API interna do jitsi-meet **desta versão da imagem** entrega
as faixas remotas. **Se este passo falhar, os passos seguintes não adiantam**
e a decisão volta à mesa (ver `deploy/jitsi/README.md` do `clubmed-web-2024`,
Passo 0/§ "abordagens", para o que fazer nesse caso).

Se o stack já está no ar noutra versão da imagem, entre numa sala **com dois
participantes** e rode no console do navegador:

```js
APP.store.getState()['features/base/tracks'].filter(t => t.mediaType === 'audio' && !t.local)
```

Tem que voltar pelo menos um item. Vazio ou erro → teste o fallback que o
script usa:

```js
[...document.querySelectorAll('audio')].map(a => a.srcObject).filter(Boolean)
```

Basta **um dos dois** funcionar. Se nenhum funcionar, ainda dá para subir o
stack normalmente (Passo 6 sem `-f custom/docker-compose.custom.yml`) — só a
ponte de áudio fica de fora.

### Passo 6 — Sincronizar o script (se mudou)

Pule se é a primeira instalação e o arquivo já está com o conteúdo certo:

```bash
cp <repo-clubmed-web-2024>/deploy/jitsi/transcricao-bridge.js \
   custom/web-transcricao/transcricao-bridge.js
```

### Passo 7 — Subir o stack inteiro, já com a ponte de áudio

Da raiz do repo (os caminhos em `custom/docker-compose.custom.yml` são
relativos à raiz do projeto, não ao arquivo — ver comentário lá dentro):

```bash
docker compose -f docker-compose.yml -f custom/docker-compose.custom.yml up -d --build
```

Builda a camada fina do `web` (baixa a imagem base publicada na primeira vez,
depois só a camada fina muda) e sobe `prosody`, `jicofo`, `jvb` e `web`
juntos. Numa atualização de um stack já rodando, `--build` recria só o que
mudou; ainda assim prefira uma janela sem consulta ativa.

### Passo 8 — Verificar

```bash
curl -s https://SEU_DOMINIO/transcricao-bridge.js | head -3
curl -s https://SEU_DOMINIO/ | grep transcricao-bridge
```

O primeiro devolve o cabeçalho do arquivo (comentário JSDoc). O segundo mostra
a tag `<script src="/transcricao-bridge.js" defer>` — se vier vazio, o `web`
está rodando a imagem publicada (`ghcr.io/jitsi/web`), não a camada custom:
confira `docker compose images web` (deveria listar
`clubmed/jitsi-web-transcricao`).

Teste real: abra uma teleconsulta pelo prontuário v2 com o paciente na sala e
confirme no painel de transcrição que as duas barras de nível se movem e as
falas saem rotuladas `Méd`/`Pac`.

---

## Trocar o conteúdo do script depois

Repita os Passos 6 e 7. O arquivo faz parte da imagem — não há atalho sem
rebuild, mas como só a camada fina muda, o build reaproveita o cache da base
e roda em segundos, não minutos.

## Rollback

```bash
docker compose -f docker-compose.yml up -d web
```

Volta a pull da imagem publicada (`${JITSI_IMAGE_REPO}/web:${JITSI_IMAGE_VERSION}`),
sem a camada custom. Transcrição volta a só o médico; a chamada não é afetada
em nenhum momento.

## Depois de cada atualização do Jitsi

1. Atualize `JITSI_IMAGE_VERSION` no `.env`.
2. Repita o Passo 7 (`--build`) para a camada fina acompanhar a nova base.
3. Refaça o Passo 5 (pré-condição) e o teste do Passo 8: a API interna
   (`APP.store`) usada pelo `transcricao-bridge.js` pode mudar de forma entre
   versões. Se mudar, o script cai no fallback dos elementos `<audio>`; se os
   dois falharem, vira no-op e avisa `indisponivel` — nunca falha em silêncio.
