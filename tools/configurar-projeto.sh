#!/usr/bin/env bash
# Configura as variaveis de ambiente do projeto Vercel da suite Reversa Gov e
# dispara o deploy. Roda depois que o projeto existe (import do repo GitHub).
#
#   VERCEL_TOKEN=xxx POSTGRES_URL=postgresql://... ./tools/configurar-projeto.sh
#
# Nao toca em nenhum outro projeto: resolve o id pelo nome da suite e grava
# apenas as envs dela.
set -euo pipefail

PROJETO="${PROJETO:-reversa-gov-suite}"
TEAM="${TEAM:-team_FtOe2aGUEBCClp33AUX3fjb2}"
DOMINIO="${DOMINIO:-https://$PROJETO.vercel.app}"

: "${VERCEL_TOKEN:?informe VERCEL_TOKEN}"
: "${POSTGRES_URL:?informe POSTGRES_URL do banco do ambiente Gov}"
: "${SESSION_SECRET:?informe SESSION_SECRET}"
: "${RESET_TOKEN_PEPPER:?informe RESET_TOKEN_PEPPER}"
: "${REVERSA_SECRET:?informe REVERSA_SECRET}"
: "${SENHA_LEGADO:?informe a senha do usuario legado}"

api() { curl -sS -m 40 -H "Authorization: Bearer $VERCEL_TOKEN" "$@"; }

PROJECT_ID="$(api "https://api.vercel.com/v9/projects/$PROJETO?teamId=$TEAM" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"
if [ -z "$PROJECT_ID" ]; then echo "projeto $PROJETO nao encontrado"; exit 1; fi
echo "projeto: $PROJETO ($PROJECT_ID)"

gravar() { # chave valor tipo
  local key="$1" value="$2" type="$3"
  # remove a versao existente antes de gravar
  local ids
  ids="$(api "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM&decrypt=true" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in (d.get('envs') or []):
    if e.get('key')=='$key': print(e.get('id'))
")"
  for id in $ids; do
    api -X DELETE "https://api.vercel.com/v9/projects/$PROJECT_ID/env/$id?teamId=$TEAM" >/dev/null
  done
  api -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json,sys
print(json.dumps({'key':'$key','value':sys.argv[1],'type':'$type','target':['production','preview']}))
" "$value")" >/dev/null
  echo "  gravada: $key"
}

echo "gravando as variaveis de ambiente:"
gravar POSTGRES_URL        "$POSTGRES_URL"        encrypted
gravar SESSION_SECRET      "$SESSION_SECRET"      encrypted
gravar REVERSA_SECRET      "$REVERSA_SECRET"      encrypted
gravar RESET_TOKEN_PEPPER  "$RESET_TOKEN_PEPPER"  encrypted
gravar LEGACY_AUTH_UNTIL   "2027-12-31"           plain
gravar REVERSA_USERS       "andre:$SENHA_LEGADO"  encrypted
gravar APP_BASE_URL        "$DOMINIO"             plain
gravar MAIL_FROM           "atintilio@argusprime.com.br" plain
gravar MAIL_REPLY_TO       "atintilio@argusprime.com.br" plain
gravar BOOTSTRAP_OWNER_EMAIL "atintilio@argusprime.com.br" plain
gravar BOOTSTRAP_OWNER_NAME  "André Carlos Tintilio"      plain

echo "pronto. o deploy dispara no proximo push em main."
