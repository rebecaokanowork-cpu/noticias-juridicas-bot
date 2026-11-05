# Setup — Instagram Bot do Notícia Jurídica

## O que você precisa fazer (uma vez só)

### 1. Criar repositório público no GitHub
Suba esta pasta `instagram-bot/` como um repositório público.
Repo público = GitHub Actions ilimitado (gratuito).

### 2. Criar o Meta Developer App

1. Acesse https://developers.facebook.com/apps/
2. Clique em **Criar app** → escolha **Business**
3. Adicione o produto **Instagram Graph API**
4. Em **Instagram Graph API > Configurações**, conecte sua conta Instagram Business
5. Gere um **User Access Token** com as permissões:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_read_engagement`
6. Converta para **Long-Lived Token** (válido 60 dias):
   ```
   GET https://graph.facebook.com/v21.0/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={app-id}
     &client_secret={app-secret}
     &fb_exchange_token={short-token}
   ```
7. Pegue seu **Instagram User ID**:
   ```
   GET https://graph.instagram.com/v21.0/me?access_token={token}
   ```

### 3. Adicionar Secrets no GitHub

No repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret           | Valor                        |
|------------------|------------------------------|
| `IG_ACCESS_TOKEN`| Seu Long-Lived Token         |
| `IG_USER_ID`     | Seu Instagram User ID        |

### 4. Pronto

O bot vai rodar automaticamente às **08h, 13h e 18h (horário de Brasília)**.
Você também pode acionar manualmente em **Actions → Post Instagram → Run workflow**.

---

## Testar localmente

```bash
cd instagram-bot
npm install
node scripts/post.js --dry-run
```

O `--dry-run` gera os cards em `data/cards/` sem fazer upload nem postar.

---

## Renovar o Access Token (a cada 60 dias)

Execute a chamada de refresh:
```
GET https://graph.instagram.com/refresh_access_token
  ?grant_type=ig_refresh_token
  &access_token={token_atual}
```

Atualize o secret `IG_ACCESS_TOKEN` no GitHub com o novo token.

---

## Arquitetura

```
noticias.json (site)
      ↓
GitHub Actions (cron 3x/dia)
      ↓
Puppeteer → card PNG 1080×1080
      ↓
catbox.moe (upload gratuito, URL pública)
      ↓
Instagram Graph API → publicação
      ↓
posted.json (commit automático)
```
