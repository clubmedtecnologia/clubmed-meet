/**
 * transcricao-bridge.js — entrega o áudio REMOTO da sala ao aplicativo que
 * hospeda o iframe do Jitsi, para que a transcrição da teleconsulta capte a voz
 * do paciente e não só a do médico.
 *
 * CÓPIA SINCRONIZADA — a origem é `deploy/jitsi/transcricao-bridge.js` no repo
 * `clubmed-web-2024`. Edite LÁ (é onde o protocolo postMessage é versionado
 * junto do `jitsi-audio-bridge.ts` que fala com ele) e copie o arquivo para cá
 * antes de rodar `docker compose ... --build web` — ver `README.md` desta
 * pasta. Editar só esta cópia perde a mudança no próximo sync.
 *
 * ONDE ISTO RODA: dentro do domínio deste Jitsi self-hosted, embutido na
 * imagem `web` por `custom/web-transcricao/Dockerfile`.
 *
 * POR QUE EXISTE: o iframe é cross-origin. Da página do prontuário não há como
 * alcançar as faixas de áudio remotas da chamada, e o microfone do médico não
 * serve — o `echoCancellation` remove dele, de propósito, justamente o áudio do
 * paciente que sai pelo alto-falante.
 *
 * O QUE TRAFEGA: áudio PCM 16-bit @24 kHz, ~48 KB/s. Nenhum texto, nenhuma
 * transcrição — quem transcreve continua sendo o transcription-service.
 *
 * PROTOCOLO (postMessage, sempre com origem verificada dos dois lados):
 *   app  → jitsi : { tipo: 'transcricao:iniciar' }
 *   jitsi → app  : { tipo: 'transcricao:pronto' }
 *   jitsi → app  : { tipo: 'transcricao:audio', pcm: ArrayBuffer }   (transferível)
 *   jitsi → app  : { tipo: 'transcricao:indisponivel', motivo: string }
 *   app  → jitsi : { tipo: 'transcricao:parar' }
 *
 * MODO DE FALHA: tudo em try/catch. Se as faixas não puderem ser lidas, o
 * script vira no-op, avisa `indisponivel` e A CHAMADA NÃO É AFETADA — a
 * transcrição volta ao comportamento de antes (só o médico), com o painel do
 * prontuário mostrando "Paciente: sem áudio". Nunca falha em silêncio.
 */
(function () {
    'use strict';

    // ── Allowlist de origem ──────────────────────────────────────────────────
    // Quem pode pedir o áudio da sala. A aplicação é multi-tenant por
    // subdomínio, então a regra cobre `*.clubmed.digital`.
    //
    // Sem isto, qualquer página que incorporasse este Jitsi num iframe poderia
    // pedir o áudio da consulta.
    var ORIGENS_PERMITIDAS = [
        /^https:\/\/([a-z0-9-]+\.)*clubmed\.digital$/,

        // FASE 2 (GOV/UBS) — descomentar quando a captura for habilitada lá:
        // /^https:\/\/([a-z0-9-]+\.)*ubsvirtual\.com$/,

        // DESENVOLVIMENTO — descomentar APENAS enquanto se testa o front local
        // contra este Jitsi, e comentar de volta em seguida. Deixar ligado num
        // servidor de produção permitiria a uma página local qualquer pedir o
        // áudio de uma consulta real.
        // /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/,
    ];

    var TAXA = 24000;              // exigida pela OpenAI Realtime
    var AMOSTRAS_POR_FRAME = 2400; // ~100 ms
    var INTERVALO_VARREDURA_MS = 2000;

    // Mesmo encoder do `src/assets/worklets/pcm-encoder.worklet.js`, embutido:
    // o worklet precisa ser carregado da origem do Jitsi, e buscar o arquivo do
    // outro domínio esbarraria em CORS.
    var FONTE_WORKLET = [
        'class PonteEncoder extends AudioWorkletProcessor {',
        '  constructor(o) {',
        '    super();',
        '    this.n = (o && o.processorOptions && o.processorOptions.amostrasPorFrame) || 2400;',
        '    this.buf = new Int16Array(this.n);',
        '    this.i = 0;',
        '  }',
        '  process(inputs) {',
        '    var c = inputs[0] && inputs[0][0];',
        '    if (!c) { return true; }',
        '    for (var k = 0; k < c.length; k++) {',
        '      var s = Math.max(-1, Math.min(1, c[k]));',
        '      this.buf[this.i++] = s < 0 ? s * 0x8000 : s * 0x7fff;',
        '      if (this.i === this.n) {',
        '        var f = this.buf.slice();',
        '        this.port.postMessage(f.buffer, [f.buffer]);',
        '        this.i = 0;',
        '      }',
        '    }',
        '    return true;',
        '  }',
        '}',
        "registerProcessor('pcm-encoder-ponte', PonteEncoder);",
    ].join('\n');

    var destino = null;        // janela que pediu (o parent)
    var destinoOrigem = null;  // origem exata dela
    var ctx = null;
    var barramento = null;     // GainNode onde todas as faixas remotas se somam
    var worklet = null;
    var sumidouro = null;      // GainNode mudo que prende o worklet ao grafo
    var conectadas = {};       // id do MediaStream → MediaStreamAudioSourceNode
    var varredura = null;
    var ativo = false;

    function permitida(origem) {
        for (var i = 0; i < ORIGENS_PERMITIDAS.length; i++) {
            if (ORIGENS_PERMITIDAS[i].test(origem)) { return true; }
        }
        return false;
    }

    function avisar(tipo, extra) {
        if (!destino || !destinoOrigem) { return; }
        var msg = { tipo: tipo };
        if (extra) { for (var k in extra) { msg[k] = extra[k]; } }
        try { destino.postMessage(msg, destinoOrigem); } catch (e) { /* parent sumiu */ }
    }

    /**
     * Faixas de áudio REMOTAS da sala (as dos outros participantes).
     *
     * Caminho principal: o store do próprio jitsi-meet, que é o dado de
     * verdade. Fallback: os elementos <audio> da página — mais frágil (depende
     * do DOM), mas independente da API interna, que pode mudar de forma entre
     * versões da imagem Docker.
     */
    function streamsRemotos() {
        var achados = [];

        try {
            var estado = window.APP && window.APP.store && window.APP.store.getState();
            var faixas = estado && estado['features/base/tracks'];
            if (faixas && faixas.length) {
                for (var i = 0; i < faixas.length; i++) {
                    var f = faixas[i];
                    if (!f || f.local || f.mediaType !== 'audio' || !f.jitsiTrack) { continue; }
                    var s = null;
                    try { s = f.jitsiTrack.getOriginalStream ? f.jitsiTrack.getOriginalStream() : f.jitsiTrack.stream; }
                    catch (e) { s = null; }
                    if (s) { achados.push(s); }
                }
            }
        } catch (e) {
            /* API interna mudou — cai no fallback abaixo */
        }

        if (!achados.length) {
            try {
                var els = document.querySelectorAll('audio');
                for (var j = 0; j < els.length; j++) {
                    var obj = els[j].srcObject;
                    // `muted` marca o próprio elemento local do Jitsi; incluí-lo
                    // devolveria a voz do médico dentro do canal do paciente.
                    if (obj && obj.getAudioTracks && obj.getAudioTracks().length && !els[j].muted) {
                        achados.push(obj);
                    }
                }
            } catch (e) {
                /* sem fallback disponível */
            }
        }

        return achados;
    }

    /**
     * Liga as faixas novas e solta as que saíram.
     *
     * Roda em intervalo porque o paciente costuma entrar DEPOIS de o médico
     * iniciar a transcrição — uma varredura única pegaria uma sala vazia e o
     * canal do paciente ficaria mudo a consulta inteira.
     */
    function sincronizarFaixas() {
        if (!ativo || !ctx || !barramento) { return; }

        var atuais = streamsRemotos();
        var vistos = {};

        for (var i = 0; i < atuais.length; i++) {
            var stream = atuais[i];
            var id = stream.id || ('s' + i);
            vistos[id] = true;
            if (conectadas[id]) { continue; }
            try {
                var no = ctx.createMediaStreamSource(stream);
                no.connect(barramento);
                conectadas[id] = no;
            } catch (e) {
                /* faixa ainda não utilizável — a próxima varredura tenta de novo */
            }
        }

        for (var id2 in conectadas) {
            if (vistos[id2]) { continue; }
            try { conectadas[id2].disconnect(); } catch (e) { /* noop */ }
            delete conectadas[id2];
        }
    }

    function iniciar(janela, origem) {
        if (ativo) { return; }
        destino = janela;
        destinoOrigem = origem;

        var Contexto = window.AudioContext || window.webkitAudioContext;
        if (!Contexto) {
            avisar('transcricao:indisponivel', { motivo: 'sem AudioContext' });
            return;
        }

        try {
            ctx = new Contexto({ sampleRate: TAXA });
        } catch (e) {
            avisar('transcricao:indisponivel', { motivo: 'AudioContext: ' + e.message });
            return;
        }

        if (!ctx.audioWorklet) {
            avisar('transcricao:indisponivel', { motivo: 'sem AudioWorklet' });
            desmontar();
            return;
        }

        var url;
        try {
            url = URL.createObjectURL(new Blob([FONTE_WORKLET], { type: 'application/javascript' }));
        } catch (e) {
            avisar('transcricao:indisponivel', { motivo: 'blob do worklet: ' + e.message });
            desmontar();
            return;
        }

        ctx.audioWorklet.addModule(url).then(function () {
            URL.revokeObjectURL(url);
            try {
                if (ctx.state === 'suspended') { ctx.resume(); }

                barramento = ctx.createGain();
                barramento.gain.value = 1;

                worklet = new AudioWorkletNode(ctx, 'pcm-encoder-ponte', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                    processorOptions: { amostrasPorFrame: AMOSTRAS_POR_FRAME },
                });
                worklet.port.onmessage = function (ev) {
                    if (!destino || !destinoOrigem) { return; }
                    try {
                        // Transferível: o buffer muda de dono em vez de ser
                        // copiado — ~10 mensagens/s durante toda a consulta.
                        destino.postMessage({ tipo: 'transcricao:audio', pcm: ev.data }, destinoOrigem, [ev.data]);
                    } catch (e) { /* parent fechou */ }
                };
                // Sumidouro com ganho ZERO até o destino. O worklet não escreve
                // na saída, e o ganho zero garante que nada seja reproduzido —
                // tocar aqui duplicaria o áudio do paciente no alto-falante do
                // médico. Ele existe porque um nó que não alcança o `destination`
                // pode não ser puxado pelo grafo, e um worklet que nunca roda
                // seria exatamente a falha silenciosa que se quer evitar.
                sumidouro = ctx.createGain();
                sumidouro.gain.value = 0;
                barramento.connect(worklet);
                worklet.connect(sumidouro);
                sumidouro.connect(ctx.destination);

                ativo = true;
                sincronizarFaixas();
                varredura = setInterval(sincronizarFaixas, INTERVALO_VARREDURA_MS);
                avisar('transcricao:pronto');
            } catch (e) {
                avisar('transcricao:indisponivel', { motivo: 'montagem: ' + e.message });
                desmontar();
            }
        }).catch(function (e) {
            try { URL.revokeObjectURL(url); } catch (e2) { /* noop */ }
            avisar('transcricao:indisponivel', { motivo: 'addModule: ' + e.message });
            desmontar();
        });
    }

    function desmontar() {
        ativo = false;
        if (varredura) { clearInterval(varredura); varredura = null; }
        for (var id in conectadas) {
            try { conectadas[id].disconnect(); } catch (e) { /* noop */ }
        }
        conectadas = {};
        if (worklet) {
            try { worklet.port.onmessage = null; worklet.disconnect(); } catch (e) { /* noop */ }
            worklet = null;
        }
        if (sumidouro) {
            try { sumidouro.disconnect(); } catch (e) { /* noop */ }
            sumidouro = null;
        }
        if (barramento) {
            try { barramento.disconnect(); } catch (e) { /* noop */ }
            barramento = null;
        }
        if (ctx) {
            try { ctx.close(); } catch (e) { /* noop */ }
            ctx = null;
        }
    }

    window.addEventListener('message', function (ev) {
        if (!ev.origin || !permitida(ev.origin)) { return; }
        var dado = ev.data;
        if (!dado || typeof dado.tipo !== 'string') { return; }

        try {
            if (dado.tipo === 'transcricao:iniciar') {
                iniciar(ev.source, ev.origin);
            } else if (dado.tipo === 'transcricao:parar') {
                desmontar();
                destino = null;
                destinoOrigem = null;
            }
        } catch (e) {
            // Nada aqui pode escapar: uma exceção não tratada nesta página é a
            // página DA CHAMADA. Melhor consulta sem transcrição do paciente do
            // que consulta interrompida.
            try { console.warn('[transcricao-bridge]', e); } catch (e2) { /* noop */ }
        }
    });

    // Encerra junto com a página, para não deixar o AudioContext pendurado.
    window.addEventListener('unload', desmontar);
})();
