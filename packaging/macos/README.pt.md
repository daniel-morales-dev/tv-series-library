# Sala para macOS 12+ — instalador

[Español](README.md) · [English](README.en.md) · **Português**

DMG com `Sala.app` e tudo incluído: Node portátil, ffmpeg/ffprobe, o servidor e a web. É compilado no GitHub Actions (`build-macos-installer`) e baixado como artifact ou da página do release; não é preciso compilar nada na máquina do dono.

## O que o instalador faz

- `Instalar Sala.command` (dois cliques no DMG): copia `Sala.app` para `/Applications` (se a conta não puder escrever lá, para `~/Applications`), remove a quarentena e a abre. Não usa sudo.
- `Sala.app/Contents/MacOS/sala` (lançador bash): se o servidor já responde, abre o navegador; se não, faz a cópia verificada do SQLite (bloqueante), inicia o servidor em segundo plano com `nohup`, espera até 30 s por `/api/health` e abre `http://127.0.0.1:8080`. Os dois processos Node carregam `--env-file-if-exists` de `Sala.app/Contents/Resources/sala/.env` e de `~/Library/Application Support/sala/.env` (ambos opcionais). Flags: `--no-open` (não abre o navegador) e `--no-agent` (não instala o autostart).
- Login: na primeira vez que o servidor inicia a partir de `/Applications`, o lançador cria `~/Library/LaunchAgents/com.sala.launcher.plist` (LaunchAgent `com.sala.launcher`, `RunAtLoad`) que inicia o servidor **em silêncio** (`--no-open`); o duplo clique normal abre o navegador.
- O estado (banco, imagens, HLS, cópias) fica em `~/Library/Application Support/sala`; os logs em `~/Library/Logs/sala/server.log`.
- Sem notarização (não há conta Apple Developer): a assinatura é ad-hoc e a primeira execução mostra o aviso do Gatekeeper → **clique com o botão direito → Abrir**. O guia `LEEME.txt` do DMG explica passo a passo.
- Assinatura ad-hoc obrigatória em Apple Silicon (`codesign --force --deep --sign -`); o build falha se `codesign --verify --strict` não passar.

## Como gerar o instalador

1. GitHub → **Actions → build-macos-installer → Run workflow** (ou subir uma tag `vX.Y.Z`).
2. Baixar os artifacts `sala-macos-installer-arm64` / `sala-macos-installer-x64`: `sala-macos-<arch>.dmg`.

Em uma tag, os dois workflows publicam no mesmo release: Windows (`sala-setup.exe` + `SHA256SUMS.txt`) e macOS (`sala-macos-arm64.dmg`, `sala-macos-x64.dmg` + `SHA256SUMS-macos.txt`).

Versões fixadas e verificadas por hash no workflow: Node **24.14.0** (SHASUMS256.txt do nodejs.org, tarball `darwin-arm64`/`darwin-x64`), ffmpeg/ffprobe **9.0.2** (`ffmpeg.martin-riedl.de`, com o `.sha256` oficial ao lado de cada zip), runners `macos-latest` (arm64) e `macos-15-intel` (x64; `macos-13` aposentado).

As dependências de produção do servidor são instaladas em um workspace isolado (`npm install --omit=dev` só com `apps/server`): ~15 MB, bem longe da árvore de desenvolvimento. O workflow falha se o staging passar de 40 MB ou contiver symlinks. O workflow **não usa segredos** e não escreve nenhum `.env` no payload: o dono configura o token depois, sem reinstalar.

## Token do TMDB (só para importar conteúdo novo)

- O instalador não inclui `.env` nem nenhum token; o build não usa segredos e o arquivo não faz parte do payload.
- Sem token, a reprodução funciona completa e offline: os títulos saem do nome do arquivo, sem pôsteres.
- O token é pedido no assistente da primeira execução (passo "Metadata de TMDB", com guia para consegui-lo) ou depois em **Ajustes** (Configurações); fica guardado em `~/Library/Application Support/sala/config.json`.
- Alternativa avançada: `TMDB_READ_ACCESS_TOKEN=...` em `~/Library/Application Support/sala/.env` ou em `Sala.app/Contents/Resources/sala/.env` (opcionais; a variável de ambiente ganha do `config.json`).

## Compilação local (referência, exige macOS)

```
# 1. Preparar packaging/macos/payload com o mesmo conteúdo que o workflow gera.
# 2. Compilar:
APP_VERSION=1.0.0 bash packaging/macos/build.sh arm64
# Saída: packaging/macos/output/sala-macos-arm64.dmg (imprime também o sha256)
```

## Desinstalar e começar do zero

1. Fechar o servidor: Monitor de Atividade (o processo `node` do Sala) ou `pkill -f Sala.app`.
2. Remover o início automático: `launchctl bootout gui/$(id -u)/com.sala.launcher` e apagar `~/Library/LaunchAgents/com.sala.launcher.plist`.
3. Arrastar `Sala.app` para o Lixo (de `/Applications` ou `~/Applications`).
4. Opcional: apagar `~/Library/Application Support/sala` (catálogo, perfis, progresso, ajustes, capas e vídeos processados). Ao reinstalar aparece o assistente de primeiro uso. Os vídeos originais (p. ex. `~/Movies/Sala`) nunca são apagados.

Para começar do zero por completo: desinstalar, apagar a pasta de dados e instalar o DMG de novo.

## Verificado no CI vs só verificável no macOS real

- **CI (real, em runner macOS):** assinatura ad-hoc (`codesign --verify --strict`), smoke test real (o lançador inicia o servidor com um `HOME` temporário, a web responde em `/api/health` e depois desliga), verificação por sha256 do Node e do ffmpeg/ffprobe contra as fontes oficiais e guardas de tamanho/symlinks do payload.
- **Só no macOS real (pendente do dono):** avisos do Gatekeeper, permissões TCC ao escolher pastas (`~/Movies`, `~/Documents`, discos externos), início automático no login, diálogos de erro do lançador, abertura do navegador e processamento real com ffmpeg.
