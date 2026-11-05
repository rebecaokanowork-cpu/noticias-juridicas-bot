/**
 * Notícia Jurídica — Instagram Bot
 * Fluxo: busca noticias.json → gera card PNG via Puppeteer
 *        → faz upload no catbox.moe → posta no Instagram Graph API
 *        → atualiza data/posted.json
 */

import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Config ──────────────────────────────────────────────────────────────────

const IG_USER_ID     = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const NOTICIAS_URL   = process.env.NOTICIAS_URL || 'https://noticiajuridicas.com.br/noticias.json';
const POSTS_PER_RUN  = parseInt(process.env.POSTS_PER_RUN || '4');

if (!DRY_RUN && (!IG_USER_ID || !IG_ACCESS_TOKEN)) {
  console.error('Erro: IG_USER_ID e IG_ACCESS_TOKEN são obrigatórios.');
  process.exit(1);
}

// ─── Tracker de posts já publicados ─────────────────────────────────────────

const postedPath = join(ROOT, 'data', 'posted.json');
const posted = new Set(
  existsSync(postedPath) ? JSON.parse(readFileSync(postedPath, 'utf8')) : []
);

// ─── Busca artigos ───────────────────────────────────────────────────────────

console.log(`Buscando artigos em ${NOTICIAS_URL}...`);
const fetchResp = await fetch(NOTICIAS_URL);
if (!fetchResp.ok) {
  console.error(`Erro ao buscar noticias.json: HTTP ${fetchResp.status} em ${NOTICIAS_URL}`);
  process.exit(1);
}

const contentType = fetchResp.headers.get('content-type') || '';
if (!contentType.includes('json')) {
  console.error(`URL não retornou JSON (recebeu: ${contentType})`);
  console.error(`Verifique se ${NOTICIAS_URL} existe e está acessível publicamente.`);
  process.exit(1);
}

const payload = await fetchResp.json();
// Suporta { noticias: [...] } ou array direto
const noticias = Array.isArray(payload) ? payload : (payload.noticias ?? payload.articles ?? []);

const toPost = noticias
  .filter(n => (n.slug || n.id) && !posted.has(n.slug || n.id))
  .slice(0, POSTS_PER_RUN);

if (toPost.length === 0) {
  console.log('Nenhum artigo novo para postar.');
  process.exit(0);
}

console.log(`${toPost.length} artigo(s) para postar.`);

// ─── Puppeteer ───────────────────────────────────────────────────────────────

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: true,
});

const cardTemplate = readFileSync(join(ROOT, 'templates', 'card.html'), 'utf8');
mkdirSync(join(ROOT, 'data', 'cards'), { recursive: true });

// ─── Loop principal ──────────────────────────────────────────────────────────

for (const noticia of toPost) {
  const titulo    = noticia.titulo   || noticia.title   || '';
  const resumo    = noticia.resumo   || noticia.summary || noticia.excerpt || '';
  const categoria = noticia.categoria || noticia.category || 'Direito';
  const slug      = noticia.slug || noticia.id;
  const dataIso   = noticia.data || noticia.date || noticia.publishedAt || new Date().toISOString();
  const imagemOriginal = noticia.imagem || noticia.image || noticia.thumbnail || '';
  const fonte          = noticia.fonte   || noticia.source || 'noticiajuridicas.com.br';
  const imagem         = await buscarImagem(titulo, categoria, imagemOriginal);

  console.log(`\n→ "${titulo.slice(0, 60)}..."`);

  try {
    // 1. Gerar imagem
    const html = cardTemplate
      .replace(/{{TITULO}}/g,    esc(titulo))
      .replace(/{{RESUMO}}/g,    esc(resumo))
      .replace(/{{CATEGORIA}}/g, esc(categoria.toUpperCase()))
      .replace(/{{DATA}}/g,      fmtDate(dataIso))
      .replace(/{{IMAGEM}}/g,    imagem)
      .replace(/{{FONTE}}/g,     esc(fonte));

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const imgBuffer = await page.screenshot({ type: 'png' });
    await page.close();

    // Salva localmente para debug
    writeFileSync(join(ROOT, 'data', 'cards', `${slug}.png`), imgBuffer);
    console.log(`  Imagem gerada (${Math.round(imgBuffer.length / 1024)} KB)`);

    if (DRY_RUN) {
      console.log('  [DRY RUN] pulando upload e post.');
      continue;
    }

    // 2. Upload no GitHub Release
    const ts = Date.now();
    const imageUrl = await uploadToGitHub(imgBuffer, `${slug}-${ts}.png`);
    console.log(`  Upload: ${imageUrl}`);

    // 3. Caption
    const caption = buildCaption({ titulo, resumo, categoria });

    // 4. Postar no Instagram
    const postId = await postToInstagram(imageUrl, caption);
    console.log(`  Publicado! ID: ${postId}`);

    // 5. Marcar como postado
    posted.add(slug);

    await sleep(8000); // aguarda entre posts para evitar rate limit

  } catch (err) {
    console.error(`  ERRO em "${titulo.slice(0, 40)}": ${err.message}`);
    // Continua para o próximo artigo
  }
}

await browser.close();

// ─── Salva tracker ───────────────────────────────────────────────────────────

writeFileSync(postedPath, JSON.stringify([...posted], null, 2));
console.log('\nTracker atualizado. Concluído.');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function buscarImagem(titulo, categoria, imagemOriginal) {
  const pixabayKey = process.env.PIXABAY_API_KEY;
  if (!pixabayKey) return imagemOriginal; // sem chave, usa original

  // Extrai palavras-chave do título (remove stopwords curtas)
  const stopwords = new Set(['para','com','que','por','uma','dos','das','são','foi','sua','seu','mais','pelo','pela','como','isso','esse','esta','este','não','mas','até','sobre']);
  const palavras = titulo
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
    .slice(0, 3);

  // Adiciona contexto jurídico
  const termo = [...palavras, 'justice', 'law'].join('+');

  try {
    const url = `https://pixabay.com/api/?key=${pixabayKey}&q=${encodeURIComponent(termo)}&image_type=photo&orientation=vertical&min_width=1080&per_page=5&safesearch=true&order=popular`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.hits && data.hits.length > 0) {
      return data.hits[0].largeImageURL;
    }
  } catch (e) {
    console.log(`  Pixabay fallback: ${e.message}`);
  }
  return imagemOriginal;
}

async function uploadToGitHub(buffer, filename) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;
  const tag   = 'card-storage';
  const api   = `https://api.github.com/repos/${repo}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Busca ou cria a release card-storage
  let releaseId;
  const getResp = await fetch(`${api}/releases/tags/${tag}`, { headers });
  if (getResp.ok) {
    releaseId = (await getResp.json()).id;
  } else {
    const createResp = await fetch(`${api}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: 'Card Storage', draft: false, prerelease: false }),
    });
    releaseId = (await createResp.json()).id;
  }

  // Faz upload do asset
  const uploadResp = await fetch(
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${filename}`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: buffer }
  );
  const asset = await uploadResp.json();
  if (!asset.browser_download_url) throw new Error(`GitHub upload falhou: ${JSON.stringify(asset)}`);
  return asset.browser_download_url;
}

async function postToInstagram(imageUrl, caption) {
  const base = `https://graph.facebook.com/v21.0/${IG_USER_ID}`;

  // Criar container
  const createResp = await fetch(`${base}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: IG_ACCESS_TOKEN }),
  });
  const createData = await createResp.json();
  if (createData.error) throw new Error(createData.error.message);

  await sleep(5000); // Instagram precisa processar a imagem

  // Publicar
  const publishResp = await fetch(`${base}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id, access_token: IG_ACCESS_TOKEN }),
  });
  const publishData = await publishResp.json();
  if (publishData.error) throw new Error(publishData.error.message);

  return publishData.id;
}

function buildCaption({ titulo, resumo, categoria }) {
  const partes = [titulo];
  if (resumo) partes.push('', resumo);
  partes.push('', '📰 Leia a íntegra: noticiajuridicas.com.br', '');

  const tags = [
    '#direitobrasil', '#jurídico', '#advocacia',
    '#noticiajuridica', '#direito', '#OAB',
    '#STJ', '#STF', '#legislação',
  ];

  const catTag = '#' + categoria.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/gi, '');
  if (!tags.includes(catTag) && catTag.length > 1) tags.push(catTag);

  partes.push(tags.join(' '));
  return partes.join('\n');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
