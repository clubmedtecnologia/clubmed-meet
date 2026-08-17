# Camada fina sobre a MESMA imagem `web` que o docker-compose.yml deste repo já
# usa (mesmo repo/tag do .env) — não builda o web/Dockerfile da raiz nem duplica
# a imagem inteira. O trabalho daqui: embutir o script da ponte de áudio do
# paciente e fazer o index.html carregá-lo.
#
# transcricao-bridge.js entra por COPY, não por volume: fica dentro da imagem,
# versionado neste repo — clonar `clubmed-meet` e buildar já é suficiente,
# sem precisar do repo `clubmed-web-2024` presente no servidor nem de um scp
# separado. O preço é rebuild a cada mudança de conteúdo (mas é só esta
# camada fina — Docker reaproveita o cache da imagem base, ~segundos).
#
# O ARQUIVO é uma CÓPIA SINCRONIZADA da origem em
# `clubmed-web-2024/deploy/jitsi/transcricao-bridge.js` — ver o cabeçalho dele
# e o README desta pasta antes de editar.
ARG JITSI_IMAGE_REPO=ghcr.io/jitsi
ARG JITSI_IMAGE_VERSION=unstable
FROM ${JITSI_IMAGE_REPO}/web:${JITSI_IMAGE_VERSION}

USER root

COPY transcricao-bridge.js /usr/share/jitsi-meet/transcricao-bridge.js

# grep antes E depois: se o </body> não existir (index.html mudou de forma numa
# versão nova do jitsi-meet-web), o BUILD FALHA aqui, alto e visível — a
# alternativa seria a injeção não acontecer e ninguém notar até reparar que o
# paciente nunca aparece na transcrição. Mesmo critério do próprio
# transcricao-bridge.js: nunca falhar em silêncio.
RUN grep -q '</body>' /usr/share/jitsi-meet/index.html \
    && sed -i 's#</body>#    <script src="/transcricao-bridge.js" defer></script>\n</body>#' /usr/share/jitsi-meet/index.html \
    && grep -q 'transcricao-bridge.js' /usr/share/jitsi-meet/index.html

USER s6
