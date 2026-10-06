# BrightMon

**BrightMon** é um aplicativo para Windows que permite ajustar o brilho de monitores compatíveis pela bandeja do sistema. Este repositório contém uma versão derivada do [Twinkle Tray](https://github.com/xanderfrangos/twinkle-tray), com identidade e configuração localizadas para BrightMon. O upstream é citado como origem do projeto; este repositório não é o canal oficial de downloads do Twinkle Tray.

> **Versão neste checkout:** 1.2.0. Os instaladores e arquivos gerados localmente ficam em `dist/`; não há um endereço público de download do BrightMon especificado neste README.

## Recursos

- Ajuste de brilho pela janela flutuante da bandeja do Windows.
- Controle por monitor compatível via DDC/CI e, quando disponível, por caminhos específicos do Windows para telas internas.
- Controles de recursos DDC/CI informados pelo monitor, que podem incluir contraste, volume, entrada e estado de energia.
- Controle por MCP local: assistentes de IA rodando no mesmo computador (como o Claude Desktop) podem listar monitores, ajustar o brilho e desligar telas compatíveis — opt-in, sem exposição em rede.
- Ajustes por horário, detecção de inatividade, teclas de atalho e perfis de aplicativos.
- Normalização e calibração do brilho entre monitores, além de opções para telas HDR e controle por gama/software em hardware compatível.
- Sensor de luz ambiente do Windows, sensor Yocto ou sensor simulado.
- Interface traduzida por catálogos JSON; Português (Brasil) é o idioma padrão para novas configurações sem uma preferência salva.

A disponibilidade varia conforme o monitor, o driver, a conexão e os recursos implementados pelo fabricante. DDC/CI pode estar desativado por padrão no menu de configurações do próprio monitor. Alguns monitores, adaptadores, docks e conexões podem não expor todos os controles. Alterar recursos DDC/CI de energia ou entrada pode fazer certos modelos não responderem corretamente; use esses controles com cautela.

## Como a implementação funciona

### Aplicativo e interface

- [`src/electron.js`](src/electron.js) é o processo principal do Electron. Ele cria a bandeja e as janelas do painel, das configurações e da introdução; mantém as preferências do usuário e coordena as operações do aplicativo.
- A interface é escrita em React. [`src/panel.js`](src/panel.js) monta o painel de brilho e [`src/settings.js`](src/settings.js) monta as configurações. As páginas HTML de entrada ficam em [`src/html/`](src/html/).
- Os scripts `*-preload.js` fazem a ponte de IPC entre as janelas e o processo principal. As solicitações de brilho, monitor, configurações e localização passam por essa ponte; o inventário e o controle dos monitores não são executados diretamente pelo componente visual.
- [`src/Monitors.js`](src/Monitors.js) roda como processo de trabalho separado, iniciado pelo processo principal. Ele reúne os caminhos de detecção e controle e devolve resultados ao aplicativo por mensagens entre processos. Isso permite reiniciar o worker caso uma operação de monitor falhe.

### Detecção e controle de monitores

O worker combina APIs do Windows e bibliotecas nativas conforme o equipamento disponível. DDC/CI/VCP é usado para monitores externos compatíveis; WMI/WMI Bridge e APIs de configuração de vídeo do Windows cobrem outros casos. Há também caminhos específicos para HDR, Apple Studio Display e ajuste de gama por software. Nenhum caminho garante suporte universal: o aplicativo pode mostrar capacidades diferentes para cada monitor ou conexão.

### Controle por MCP local (assistentes de IA)

A opção **MCP local** fica em Configurações → Geral e está desativada por padrão; enquanto estiver desligada, nada fica escutando. Ao ativá-la, o processo principal do Electron abre um named pipe local (`\\.\pipe\BrightMon-MCP-…`) protegido por um token gravado em `%LOCALAPPDATA%\BrightMon\mcp.json`. O cliente MCP é um servidor `stdio` separado, iniciado pelo próprio assistente, que encaminha cada chamada ao pipe — nenhuma porta de rede é aberta e nada sai do computador.

Ferramentas expostas (somente essas três, sem comandos genéricos):

- `list_displays` — id opaco, nome, posição atual na UI, brilho conhecido e capacidades (ajustável/energia/oculto), sem seriais ou HWIDs.
- `set_brightness` — um id exato e um número 0–100; reutiliza o pipeline completo de brilho (calibração, HDR/gama, WMI, DDC/CI).
- `turn_off_display` — uma tela por vez, apenas quando o monitor expõe o recurso DDC/CI de energia (VCP 0xD6 habilitado para o monitor); nunca alterna nem afeta outras telas.

Alvos são resolvidos por igualdade exata contra o inventário atual; “monitor 1” só resolve quando a posição for inequívoca. As respostas indicam comando aceito/enviado e não confirmam o estado físico do hardware — o worker não retorna confirmação de escrita.

Para conectar o Claude Desktop, use o bloco de configuração copiável em Configurações → Geral → MCP local (em `claude_desktop_config.json`) ou gere e instale a extensão `artifacts\BrightMon.mcpb` pelo menu Settings → Extensions → Install Extension do Claude Desktop.

Arquivos principais: [`src/mcp/`](src/mcp/) (lógica compartilhada e servidor do pipe usados pelo processo principal), [`mcp/`](mcp/) (servidor `stdio`, manifest e build da extensão) e [`tests/mcp/`](tests/mcp/).

### Localização

Os catálogos de idioma ficam em [`src/localization/`](src/localization/). [`src/Translate.js`](src/Translate.js) procura primeiro a tradução escolhida e usa `en.json` como fallback; [`src/TranslateReact.js`](src/TranslateReact.js) disponibiliza essa tradução aos componentes React. O processo principal escolhe o idioma do sistema ou a preferência salva e notifica as janelas por IPC.

## Desenvolvimento e compilação

O projeto é direcionado ao Windows e usa dependências nativas Node.js. Para instalar dependências nativas ou compilar do código-fonte, prepare um ambiente Windows com Node.js/npm e as ferramentas de compilação exigidas por `node-gyp` e pelos módulos nativos utilizados pelo projeto.

```powershell
# Instale as dependências; o postinstall prepara as dependências do Electron.
npm install

# Inicie o aplicativo em modo de desenvolvimento.
npm start

# Gere os recursos da interface em build/.
npm run parcel-build

# Gere o instalador NSIS x64 em dist/.
npm run electron-build
```

Scripts adicionais definidos em [`package.json`](package.json):

| Comando | Resultado |
| --- | --- |
| `npm run build` | Instala as dependências com `npm ci`, compila a interface, gera o bundle MCP e o instalador x64. |
| `npm run portable` | Compila a interface e gera um pacote ZIP portátil x64. |
| `npm run appx` | Compila a interface e tenta gerar o pacote AppX x64. |
| `npm run appx-arm64` | Compila a interface e tenta gerar o pacote AppX ARM64. |
| `npm run arm64` | Compila a interface e gera um pacote ZIP ARM64. |
| `npm run build-all` | Executa o build padrão, AppX x64 e AppX ARM64. |
| `npm run mcp:build` | Gera o bundle do servidor MCP em `artifacts/mcp/` e a extensão `artifacts/BrightMon.mcpb`. |
| `npm run test:mcp` | Executa os testes do módulo MCP (lógica, servidor de pipe e E2E `stdio`). |
| `npm run test-wmibridge` | Executa o exemplo de teste do WMI Bridge. |
| `npm run parcel` | Inicia o servidor Parcel para desenvolvimento da interface. |
| `npm start` | Abre o aplicativo com Electron em modo de desenvolvimento. |

O empacotamento NSIS deste checkout está configurado para instalação por usuário (`perMachine: false`), sem instalação global para todos os usuários. Os artefatos de compilação não são publicados automaticamente por esses comandos. O workflow de CI herdado ainda usa nomes e identificadores do upstream em alguns alvos; confira a configuração correspondente antes de distribuir builds de CI como releases do BrightMon.

## Créditos e licenças

BrightMon deriva do **Twinkle Tray**, criado por **Xander Frangos**. Agradecemos a Xander e às pessoas que contribuíram com o projeto original e seus recursos. O histórico e o código upstream podem ser consultados em [xanderfrangos/twinkle-tray](https://github.com/xanderfrangos/twinkle-tray).

Entre as bibliotecas e módulos relacionados ao controle de telas usados neste repositório estão:

- [`node-ddcci`](src/modules/node-ddcci/package.json), de Matt Hensman — comunicação DDC/CI.
- [`win32-displayconfig`](src/modules/win32-displayconfig/package.json), de Daniel Sweet — enumeração/configuração de monitores no Windows.
- [`node-active-window`](src/modules/node-active-window/package.json), de Paymo SRL — identificação da janela em foco usada pelos perfis.
- [`wmi-bridge`](src/modules/wmi-bridge/package.json), utilizado para comunicação com WMI no Windows.
- Electron, Node.js, React, Parcel e demais dependências listadas em [`package.json`](package.json).

Os avisos de copyright e a licença principal estão em [`LICENSE`](LICENSE). As dependências incluídas podem ter autores, avisos e licenças próprios — por exemplo, `node-active-window` declara GPL-3.0. Consulte os arquivos `LICENSE`, `COPYRIGHT`, `CONTRIBUTORS` e `package.json` junto de cada módulo antes de redistribuir; a licença MIT do repositório não substitui as obrigações das dependências.

## Segurança

As janelas Electron deste aplicativo usam atualmente `nodeIntegration: true` e `contextIsolation: false`; a janela de configurações também desativa `webSecurity` e permite conteúdo inseguro em certas condições. Isso amplia os riscos caso conteúdo não confiável seja carregado. Mantenha as janelas restritas aos recursos locais do aplicativo e não navegue para páginas remotas em uma janela privilegiada.
