# Sala para Windows 11 — instalador

[Español](README.md) · [English](README.en.md) · **Português**

Instalador `.exe` (Inno Setup 6) com tudo incluído: Node portátil, ffmpeg/ffprobe, o servidor e a web. É compilado no GitHub Actions (`build-windows-installer`) e baixado como artifact; não é preciso compilar nada na máquina do dono.

## O que o instalador faz

- Copia o payload em `C:\Program Files\Sala`: `node\node.exe`, `ffmpeg\bin\`, `apps\server` (código + dependências de produção), `apps\web\dist`, `scripts\dev.mjs`, `package.json` e `sala-launcher.vbs`. **Sem `.env` e sem credenciais**: o instalador não inclui nenhum token.
- Cria a regra de firewall `Sala 8080` (só `LocalSubnet`) e a remove na desinstalação.
- Adiciona um atalho no menu Iniciar e outro em **Inicializar** (`wscript.exe sala-launcher.vbs`, sem janela).
- `sala-launcher.vbs`: se o servidor já responde, abre o navegador; se não, faz a cópia verificada do SQLite (bloqueante), inicia o servidor em segundo plano, espera até 30 s por `/api/health` e abre `http://127.0.0.1:8080`. Os dois processos Node carregam `--env-file-if-exists` de `<install>\.env` e de `%LOCALAPPDATA%\sala\.env` (ambos opcionais).
- O estado (banco, imagens, HLS, cópias) fica em `%LOCALAPPDATA%\sala`. Na desinstalação ele pergunta se deve apagar; em modo silencioso é mantido.
- Sem assinatura digital: o SmartScreen mostra "O Windows protegeu seu PC" → **Mais informações → Executar assim mesmo**.

## Como gerar o instalador

1. GitHub → **Actions → build-windows-installer → Run workflow** (ou subir uma tag `vX.Y.Z`).
2. Baixar o artifact `sala-windows-installer`: `sala-setup-<version>.exe` + `SHA256SUMS.txt`.

Versões fixadas e verificadas por hash no workflow: Node **24.14.0** (SHASUMS256.txt do nodejs.org), ffmpeg **9.0.2 essentials** (gyan.dev, inclui libx264) e Inno Setup **6.7.1**.

As dependências de produção do servidor são instaladas em um workspace isolado (`npm install --omit=dev` só com `apps/server`): ~15 MB, bem longe da árvore de desenvolvimento (~166 MB). O workflow falha se o staging passar de 40 MB ou contiver symlinks. O workflow **não usa segredos** e não escreve nenhum `.env` no payload: o instalador é publicado sem token e o dono o configura depois na própria máquina (ver abaixo), sem reinstalar.

## Token do TMDB (só para importar conteúdo novo)

- O instalador não inclui `.env` nem nenhum token; o build não usa segredos e o arquivo não faz parte do payload.
- Sem token, a reprodução funciona completa e offline: os títulos saem do nome do arquivo, sem pôsteres.
- O token é pedido no assistente da primeira execução (passo "Metadata de TMDB", com guia para consegui-lo) ou depois em **Ajustes** (Configurações); fica guardado em `%LOCALAPPDATA%\sala\config.json`.
- Alternativa avançada: `TMDB_READ_ACCESS_TOKEN=...` em `%LOCALAPPDATA%\sala\.env` ou `<install>\.env` (opcionais; a variável de ambiente ganha do `config.json`).

## Compilação local (referência, exige Windows)

```
# 1. Preparar packaging\windows\payload com o mesmo conteúdo que o workflow gera.
# 2. Compilar:
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=1.0.0 packaging\windows\sala.iss
# Saída: packaging\windows\output\sala-setup-1.0.0.exe
```

## Desinstalar e começar do zero

Desde a v0.1.4 o desinstalador fecha o `node.exe`/`ffmpeg.exe` do Sala (por caminho, sem tocar em outros Node) e pergunta **"Apagar também seus dados do Sala?"**:

- **Sim**: apaga `%LOCALAPPDATA%\sala` (catálogo, perfis, progresso, ajustes, capas e vídeos processados). Ao reinstalar aparece o assistente de primeiro uso.
- **Não**: mantém tudo; ao reinstalar ou atualizar segue o mesmo catálogo.

Os vídeos originais (p. ex. `%USERPROFILE%\Videos\Sala`) nunca são apagados.

Limpeza manual (v0.1.3 ou anteriores), no PowerShell como administrador e com a sessão do usuário que usa o Sala:

```powershell
Get-Process node,ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\Program Files\Sala\*' } | Stop-Process -Force
Start-Sleep 2
Remove-Item "$env:LOCALAPPDATA\sala" -Recurse -Force
Remove-Item "$([Environment]::GetFolderPath('Startup'))\Sala.lnk" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Videos\Sala\.sala-library.json" -ErrorAction SilentlyContinue
```

Depois desinstale em Configurações → Aplicativos e apague `C:\Program Files\Sala` se tiver sobrado. Se `http://127.0.0.1:8080` ainda carrega, tem um servidor antigo vivo.

## Só verificável no Windows real

Execução do `.exe` com UAC, SmartScreen, regra de firewall, autostart no login, abertura do navegador pelo `.vbs`, processamento real com ffmpeg (libx264) e desinstalação limpa. No Linux só são validados testes, typecheck, sintaxe do workflow e o tamanho do payload.
