# NANO BOT — WhatsApp

Bot de gestão de grupo com Baileys, SQLite e OCR. O emparelhamento é feito por **código numérico**, não por QR Code.

> Aviso: Baileys é uma biblioteca não oficial que utiliza a ligação WhatsApp Web. O WhatsApp pode alterar o protocolo ou limitar contas. Utilize uma conta autorizada e cumpra os termos aplicáveis. O OCR apenas extrai texto: não comprova que o dinheiro entrou na conta.

## Funcionalidades
- Comandos administrativos: ban, abrir/fechar grupo, filtros, contas de pagamento, clientes, membros sem compras, ranking, promoção/despromoção.
- Antilink configurável, filtros de foto/vídeo/áudio, boas-vindas e respostas NANO.
- Compras registadas em SQLite, ranking e histórico básico.
- Respostas `tabela` e `pagamento`.
- Receção de imagens/documentos como possível comprovativo; OCR tenta extrair valor, referência e data e pede confirmação de administrador. A confirmação é manual.
- Emparelhamento por código de 8 dígitos.

## 1. Criar o repositório GitHub
1. Crie um repositório chamado `nano-whatsapp-bot`.
2. Carregue todos os ficheiros desta pasta. Não carregue `.env`, `auth_info/`, `data/` nem credenciais.
3. No GitHub, abra **Settings → Secrets and variables → Actions** se for usar CI; não coloque a sessão WhatsApp em secrets de texto ou no código.

## 2. Executar num servidor 24/7 (exemplo: Railway)
1. Crie um projeto no Railway e ligue o repositório GitHub.
2. Adicione um **Volume persistente** e monte-o, por exemplo, em `/data`.
3. Defina variáveis:
   - `DATA_DIR=/data`
   - `PORT=3000` (normalmente o Railway injeta PORT automaticamente)
   - `OWNER_NUMBERS=25884XXXXXXX,25886XXXXXXX` (opcional; números sem `+`)
   - `OCR_LANG=eng`
4. Faça deploy e abra os logs de execução.
5. A primeira ligação pede o número do WhatsApp em formato internacional sem `+`. Introduza-o no terminal/log interativo se o alojamento suportar entrada interativa. Muitos serviços cloud **não permitem entrada no terminal do processo**; nesse caso, use o modo de emparelhamento por variável temporária `PAIRING_NUMBER` apenas se a plataforma permitir definir a variável e reiniciar. Veja abaixo.

### Emparelhamento por código
- Para emparelhamento, a biblioteca precisa de pedir um código e mostrar o código de 8 dígitos nos logs.
- Em alojamentos sem terminal interativo, defina temporariamente `PAIRING_NUMBER=25884XXXXXXX` nas variáveis do serviço, faça deploy/reinicie e leia `PAIRING CODE` nos logs. Depois de emparelhar, remova `PAIRING_NUMBER` e reinicie.
- No WhatsApp do telefone: **Definições → Dispositivos associados → Associar um dispositivo → Associar com número de telefone** (a disponibilidade/nome pode variar por versão). Introduza o código apresentado.
- Nunca partilhe o código. Guarde a pasta `auth_info` dentro do `DATA_DIR` persistente.

## 3. Executar localmente para testes
Requer Node.js 20+.
```bash
cp .env.example .env
npm install
npm start
```
Para pedir o código, defina `PAIRING_NUMBER=25884XXXXXXX` no ambiente antes de iniciar:
```bash
PAIRING_NUMBER=25884XXXXXXX npm start
```
O bot nunca mostra QR Code; se a biblioteca emitir QR internamente, o programa não o imprime.

## Comandos principais
- `.menu`
- `.ban @membro` (ou `.ban 258XXXXXXXXX`, ou responder à mensagem do membro)
- `.grupo a`, `.gp a` — abrir; `.grupo f`, `.gp f` — fechar
- `.compra 620mb` (admin; responder à mensagem do comprador para registar outra pessoa)
- `.compras on|off|mb|gb|saldo`
- `.clientes`, `.rentanas`, `.removerrentanas`, `.fantasmas 10`
- `.p`, `.pp`, `.resetcompras` (este último pede confirmação com `.resetcompras confirmar`)
- `tabela`, `pagamento`
- `.nandoadd texto da tabela`
- `.nanoaddmpesa 841234567`
- `.addmpesa 841234567`, `.addmola 861234567`, `.contas`, `.delmpesa 1`, `.delmola 1`
- `.antilink on|off`, `.antifoto on|off`, `.antivideo on|off`, `.antiaudio on|off`, `.antistatus on|off`, `.detector on|off`, `.anticoncorrencia on|off`
- `.status`
- `.promover @membro`, `.demote @membro`, `.todos mensagem`
- `.bsvindo texto`, `.bemvindo on|off`
- `.nanoadd gatilho,resposta`, `.nanodel gatilho`, `.listanano`, `.limparnanos`
- `.alarme HH:MM abrir|fechar` (alarmes são verificados enquanto o processo está ligado)
- `.anular` — anula a compra mais recente do membro mencionado/respondido ou do próprio emissor, se autorizado.
- `.addconcorrente LID`, `.removeconcorrente LID`, `.certificarconcorencia`

## Limitações e segurança
- O bot só consegue administrar grupos se a conta ligada for administradora e a biblioteca expuser a operação.
- Apagar links depende de o bot ser admin. Nenhum sistema consegue garantir apagar “imediatamente” em todas as condições de rede.
- `limpar` só consegue apagar mensagens conforme as permissões e os identificadores disponíveis; não consegue apagar todo o histórico universalmente.
- OCR é sujeito a erros. Os comprovativos ficam pendentes de validação manual. Não há integração oficial de consulta de saldo/transações M-Pesa/e-Mola incluída.
- A remoção de membros sem compras é destrutiva; o bot pede confirmação: `.removerrentanas confirmar`.
- `.resetcompras` também pede confirmação.
- Não existe uma forma segura de confiar apenas em imagem/OCR como prova de pagamento.

## Persistência
O banco é criado automaticamente em `$DATA_DIR/nano.sqlite`. Mantenha o volume persistente para não perder clientes, compras, definições e sessão. Faça cópias de segurança regulares e restrinja o acesso ao volume.

