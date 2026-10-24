#!/usr/bin/env bash
# Cria o banco do ambiente Reversa no Neon e devolve a connection string.
#
#   NEON_API_KEY=napi_xxx ./tools/criar-neon.sh
#
# Cria o projeto (ou reaproveita se ja existir), garante a branch principal e
# imprime a connection string para usar como POSTGRES_URL.
set -euo pipefail

NOME="${NOME:-Reversa Gov}"
REGIAO="${REGIAO:-aws-us-east-1}"
API="https://api.neon.tech/v2"

: "${NEON_API_KEY:?informe NEON_API_KEY}"

auth() { curl -sS -m 60 -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" "$@"; }

# 1) projeto
PROJECTS="$(auth "$API/projects" -d "{\"name\":\"$NOME\",\"region\":\"$REGIAO\"}")"
PROJECT_ID="$(printf '%s' "$PROJECTS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'id' in d: print(d['id'])
else:
    ps=d.get('projects') or []
    m=[p for p in ps if p.get('name')=='$NOME']
    print(m[0]['id'] if m else '')
")"
if [ -z "$PROJECT_ID" ]; then echo "erro ao criar o projeto:"; printf '%s' "$PROJECTS" | head -c 400; exit 1; fi
echo "projeto: $NOME ($PROJECT_ID) em $REGIAO"

# 2) branch principal
BRANCH_ID="$(auth "$API/projects/$PROJECT_ID/branches" -d "{\"branch\":{\"name\":\"main\"}}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
b=d.get('branch') or {}
if b.get('id'): print(b['id'])
else:
    bs=d.get('branches') or []
    print(bs[0]['id'] if bs else '')
")"
echo "branch: $BRANCH_ID"

# 3) connection string (pooled=false = conexao direta, sem pooler)
URI="$(auth "$API/projects/$PROJECT_ID/connection_uri?branch_id=$BRANCH_ID&role_name=neon_superuser&database_name=neon_main&pooled=false" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('uri',''))
")"
if [ -z "$URI" ]; then echo "erro ao obter a connection string"; exit 1; fi
echo
echo "POSTGRES_URL=$URI"
