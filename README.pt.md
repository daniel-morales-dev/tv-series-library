# Sala

[Español](README.md) · [English](README.en.md) · **Português**

Plataforma local para assistir seus filmes, séries e animes de qualquer aparelho conectado ao seu WiFi (TV, celular, tablet ou PC). Sem anúncios e sem contas, com perfis, Minha lista e Continuar assistindo.

> **Início local:** `npm run dev` a partir da raiz inicia o backend (8080) e o frontend (5174), com cópia verificada do SQLite e parada conjunta com `Ctrl+C`. Guia e aviso de cópia/migração: [docs/local-development.md](docs/local-development.md). Se você já tem uma biblioteca, leia esse aviso **antes de iniciar o backend**.
>
> Estado: funcional e em uso diário. O que falta está no plano: [`odd/tasks/tv-series-library.md`](odd/tasks/tv-series-library.md).
>
> Nota: a interface do app está em espanhol por enquanto.

## Capturas

**Desktop**

| Início | Página do título |
| :---: | :---: |
| ![Início: destaque com Continuar assistindo](docs/screenshots/01-browse.webp) | ![Página do título com temporadas e episódios](docs/screenshots/08-title-frieren.webp) |

| Player | Atividade |
| :---: | :---: |
| ![Player com controles e legendas](docs/screenshots/13-player.webp) | ![Painel de Atividade com o processamento em andamento](docs/screenshots/14-activity.webp) |

**Celular e TV**

| Início | Página do título | Player |
| :---: | :---: | :---: |
| ![Início no celular](docs/screenshots/16-browse-mobile.webp) | ![Página do título no celular](docs/screenshots/17-title-mobile.webp) | ![Player no celular](docs/screenshots/19-player-mobile.webp) |

Mais capturas (Séries, Filmes, Animes, Minha lista, Busca, Ajustes, Pendentes e perfis) em [`docs/screenshots/`](docs/screenshots).

## Como adicionar conteúdo

Coloque os vídeos dentro da pasta de conteúdo (`content/` por padrão, ou a que você escolher na primeira execução):

```
content/
├── films/      filmes (um arquivo ou uma pasta por filme)
└── shows/      séries e animes (uma pasta por título)
    └── bakemonogatari/
        └── qualquer/subpasta/episodio_01.mkv
```

- **Não precisa renomear.** O app procura em subpastas e deduz o título, a temporada e o episódio a partir dos nomes.
- **Se você está semeando um torrent (seeding), não renomeie nem mova os arquivos**: o cliente de torrent deixaria de encontrá-los.
- Baixe o torrent direto em `content/shows/` ou `content/films/`.
- Arquivos ainda baixando que possam ser identificados aparecem como **Em breve**; os outros esperam até poderem ser importados.
- Aberturas, encerramentos e comentários ficam guardados como **extras**, não como episódios.
- O que o app não reconhecer com segurança aparece em **Pendentes** para você confirmar.

## Configuração

O app guarda a pasta onde está seu conteúdo na própria configuração (`~/.config/sala/config.json` no Linux, `%LOCALAPPDATA%\sala` no Windows); você pode trocá-la em **Ajustes** (Configurações). Não edite esse arquivo à mão. O assistente de primeira execução (ou Ajustes) escolhe a pasta; a sugestão padrão é `content/`.

1. Só em uma instalação nova e **só para desenvolvimento**, crie `.env` a partir de `.env.example` **sem sobrescrever um existente**. `CONTENT_DIR` ali é opcional: sua escolha no app tem prioridade.
2. Configure seu *Read Access Token* do TMDB em `TMDB_READ_ACCESS_TOKEN`. Esta instalação já tem um; não o imprima nem suba para o git.

## Instalação

Tudo é baixado em **[Releases → última versão](https://github.com/daniel-morales-dev/tv-series-library/releases/latest)**, na seção **Assets**.

### Windows 11 — avançar, avançar, pronto

1. Baixe `sala-setup-<versão>.exe`.
2. Dê dois cliques e **Avançar → Avançar → Instalar**.
3. Se o Windows avisar *"O Windows protegeu seu PC"*: **Mais informações → Executar assim mesmo**. O instalador não tem assinatura digital paga; não é vírus.
4. Deixe marcada a caixa **Iniciar Sala e abrir o navegador** e clique em **Concluir**.

Pronto: abre http://127.0.0.1:8080 e o app volta a iniciar sozinho toda vez que você fizer login. Vem tudo incluído (Node, ffmpeg, servidor e web) e o instalador abre a porta 8080 só para a sua rede local.

Desinstalação e detalhes: [packaging/windows/README.pt.md](packaging/windows/README.pt.md).

### macOS 12 ou superior

**1. Descubra qual Mac você tem.** Menu Apple → **Sobre este Mac**:

- **Chip** diz `Apple M1`, `M2`, `M3`, `M4`… → baixe `sala-macos-arm64.dmg`.
- **Processador** diz `Intel` → baixe `sala-macos-x64.dmg`.

**2. Instale.** Dê dois cliques no `.dmg` baixado e dois cliques em **Instalar Sala**. Abre uma janela do Terminal que copia o app para Aplicativos e o abre sozinho.

**3. Se o macOS bloquear na primeira vez.** Aparece um aviso de *"desenvolvedor não identificado"*: **clique com o botão direito em `Instalar Sala` → Abrir → Abrir**. Se o aviso voltar, vá em **Ajustes do Sistema → Privacidade e segurança**, desça até a mensagem sobre o app e clique em **Abrir mesmo assim**. Só é necessário nessa vez: o app não é notarizado pela Apple.

Pronto: abre http://127.0.0.1:8080 e o app inicia sozinho no login. Seus dados ficam em `~/Library/Application Support/sala` e o log em `~/Library/Logs/sala/server.log`.

> Se sua conta não for de administrador, o app é instalado em `~/Applications` e **não** inicia sozinho no login. Você pode usá-lo normalmente.

Desinstalação e detalhes: [packaging/macos/README.pt.md](packaging/macos/README.pt.md).

### Linux (Ubuntu e derivados)

No Linux não existe instalador de dois cliques: são seis passos que você copia e cola no terminal (uns 5 minutos). Funciona no Ubuntu, Debian, Linux Mint e Pop!_OS.

**1. Abra o terminal.** Aperte `Ctrl` + `Alt` + `T`.

**2. Veja se você já tem o Node 24.** Cole isto e aperte Enter:

```sh
node --version
```

- Responde `v24.…` ou superior → pule para o **passo 4**.
- Responde um número menor, ou `command not found` → siga para o passo 3.

**3. Instale o Node 24 e o ffmpeg.** Cole as duas linhas (vai pedir sua senha; nada aparece enquanto você digita, é normal):

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg
```

Feche o terminal, abra de novo e repita o passo 2 para confirmar que agora diz `v24.…`. O Node 24 é obrigatório: o que o Ubuntu traz por padrão é velho demais.

**4. Baixe o app:**

```sh
git clone https://github.com/daniel-morales-dev/tv-series-library.git
cd tv-series-library
```

Se disser `command not found: git`, instale com `sudo apt install -y git` e repita.

**5. Instale e ative o serviço** (o primeiro comando demora um par de minutos):

```sh
npm ci
bash scripts/linux-install.sh
systemctl --user daemon-reload
systemctl --user enable --now sala
```

**6. Abra** no navegador do notebook: http://localhost:8080

O assistente de primeira execução pede a pasta onde estão seus vídeos e, se você quiser capas e sinopses, um token gratuito do TMDB. Pode deixar para depois: sem token ele reproduz igual, só sem pôsteres.

**Iniciar ao ligar, sem fazer login** (único passo com `sudo`):

```sh
sudo loginctl enable-linger "$USER"
```

Para assistir do celular e da TV, o firewall e os comandos do dia a dia: [Rodar no Linux (notebook) e assistir do celular e da TV](#rodar-no-linux-notebook-e-assistir-do-celular-e-da-tv).

## Rodar no Linux (notebook) e assistir do celular e da TV

Se você ainda não instalou, comece por [Linux (Ubuntu e derivados)](#linux-ubuntu-e-derivados). Não precisa de internet, mas o celular e a TV precisam estar no **mesmo WiFi** do notebook.

1. **Firewall, só se o ufw estiver ativo.** Primeiro veja o estado:
   ```sh
   sudo ufw status
   ```
   Se disser `inactive`, pule este passo. Se disser `active`, descubra sua sub-rede LAN:
   ```sh
   ip -4 -o addr show scope global
   ```
   Com a sua sub-rede (por exemplo `192.168.1.0/24`), abra a porta só para ela:
   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'
   sudo ufw status numbered      # conferir que a regra entrou
   ```
   Não abra para `any`: o app não tem autenticação.

2. **Conectar celular e TV.** No notebook abra http://localhost:8080, vá em **Ajustes** (Configurações) pelo menu do perfil e, em **Ver desde el celular o la TV** (Assistir do celular ou da TV), escaneie o QR com o celular ou digite a URL na TV. Se aparecerem várias URLs (Ethernet e WiFi), use a da rede WiFi.

3. **Reserve o IP do notebook no roteador** (uma vez): procure a reserva DHCP ou IP fixo por MAC e atribua o IP que Ajustes mostra. Assim a URL e o QR não mudam.

4. **Operação:**
   - Estado: `systemctl --user status sala`
   - Logs: `journalctl --user -u sala -f`
   - Parar: `systemctl --user stop sala`
   - Reiniciar: `systemctl --user restart sala`
   - Atualizar: `git pull`, depois `npm ci`, `bash scripts/linux-install.sh` e `systemctl --user restart sala`

> **Aviso:** o serviço `sala` e o `npm run dev` compartilham a porta 8080.
> - Com o serviço ativo, o `npm run dev` se recusa a rodar. Antes de desenvolver: `systemctl --user stop sala`.
> - Ao parar o serviço, o app deixa de responder (celular e TV) até você rodar `systemctl --user start sala`.
> - Parar o `npm run dev` **não** inicia o serviço: faça você mesmo com `systemctl --user start sala`.
> - Para saber se está rodando: `systemctl --user status sala` (`inactive (dead)` = parado).

### Usar o comando sala

Ao instalar com `scripts/linux-install.sh` fica o comando `sala` (em `~/.local/bin`; se seu terminal não encontrar, abra um novo ou adicione essa pasta ao PATH). Com ele você não precisa do `systemctl`:

- `sala status`: diz se está rodando e se há vídeos processando, na fila ou com erro.
- `sala start` / `sala stop` / `sala restart`: iniciar, parar e reiniciar.
- `sala pause` / `sala resume`: pausar e retomar o processamento de vídeos.
- `sala url`: o endereço para o celular e a TV. `sala open`: abre a biblioteca neste computador.
- `sala logs`: o log ao vivo (Ctrl+C para sair). `sala --help`: a ajuda.
- `sala migrate-state [--dry-run] [--yes]`: copia o banco de dados, as imagens e as cópias de recuperação de `data/` para `~/.local/share/sala/` (T47a). Verifica a cópia, **não apaga a origem** (diz como fazer) e se recusa se o app estiver ativo ou o destino não estiver vazio. Enquanto você não rodar, tudo continua usando `data/` como sempre. O vídeo (HLS) ainda não se move.

Se o `npm run dev` estiver usando a porta 8080, o `sala start` avisa em vez de falhar sem explicar. O `npm run dev` e o `npm start` continuam funcionando igual.

### Desenvolvimento vs produção

- `npm run dev`: **só desenvolvimento**. Backend com `--watch` (8080) + Vite (5174); a interface fica em http://localhost:5174.
- `npm start`: **produção**. Compila `apps/web/dist` se faltar ou estiver velho em relação ao código web, e roda só o servidor (sem watch e sem Vite) em http://localhost:8080, com as mesmas proteções de porta, pasta de dados e cópia SQLite do `dev`. O serviço `sala` roda o mesmo servidor e a mesma pasta `apps/web/dist` (a web é compilada pelo `scripts/linux-install.sh`).

## Documentação

- [Glossário](CONTEXT.md)
- [Decisões de arquitetura](docs/adr/)

## Licença

[MIT](LICENSE). Você pode usar, copiar, modificar e distribuir o app Sala, inclusive comercialmente, desde que mantenha o aviso de copyright.
