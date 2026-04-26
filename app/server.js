import express from 'express';
import path from 'path';
import { createRequire } from 'module';
import multer from 'multer';
const require = createRequire(import.meta.url);
const compression = require('compression');
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import https from 'https';
import http from 'http';
import pg from 'pg';
import OpenAI from 'openai';
import session from 'express-session';
import { createPaymentRouter } from './payment.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
// Load from Lucas-Initiative root .env for OPENAI_API_KEY
dotenv.config({ path: 'G:\\Lucas-Initiative\\.env', override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// gzip 압축 — Lighthouse 성능 개선
app.use(compression());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'hanul-sso-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000 }, // 7일
}));
app.use('/public', express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '7d',
  etag: true,
}));

// SEO: sitemap.xml / robots.txt — 루트 경로로 직접 서빙
app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, '..', 'public', 'sitemap.xml'));
});
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
});

app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'ejs');
app.set('view cache', false);

// ── DB: hanul_thought ──────────────────────────────────────────
const pool = new pg.Pool({
  host: 'localhost',
  port: 5432,
  database: 'hanul_thought',
  user: 'postgres',
  password: 'postgres',
});

// ── OpenAI (lazy init — key loaded at request time) ────────────
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

// ── 임베딩 캐시 (Map, 1시간 TTL, 최대 1000건) ──────────────────
const EMB_CACHE_TTL = 60 * 60_000; // 1시간
const EMB_CACHE_MAX = 1000;
const _embCache = new Map(); // question → { vec, ts }

async function getEmbedding(question) {
  const cached = _embCache.get(question);
  if (cached && Date.now() - cached.ts < EMB_CACHE_TTL) return cached.vec;
  const openai = getOpenAI();
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: question });
  const vec = '[' + res.data[0].embedding.join(',') + ']';
  // 상한 초과 시 가장 오래된 항목 삭제
  if (_embCache.size >= EMB_CACHE_MAX) {
    const oldest = _embCache.keys().next().value;
    _embCache.delete(oldest);
  }
  _embCache.set(question, { vec, ts: Date.now() });
  return vec;
}

// ── Cloudinary ─────────────────────────────────────────────────
const hasCloudinary = process.env.CLOUDINARY_URL || (
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

let upload;
if (hasCloudinary) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: async () => ({
      folder: 'Hanwool',
      public_id: uuidv4(),
      resource_type: 'image',
      overwrite: false,
    }),
  });
  upload = multer({ storage });
} else {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = path.join(__dirname, '..', 'public', 'uploads');
      try { if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true }); } catch {}
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.png');
      cb(null, `${uuidv4()}${ext}`);
    },
  });
  upload = multer({ storage });
}

// ════════════════════════════════════════════════════════════════
//  PAGES
// ════════════════════════════════════════════════════════════════

// / → A팀(siann-22) 메인
app.get('/', (req, res) => {
  const theme = parseInt(req.query.theme) || 1;
  res.render('siann-22', { themeId: theme, layoutId: 22, showNav: false });
});

// /v2 → B팀(siann-17) 메인
app.get('/v2', (req, res) => {
  const theme = parseInt(req.query.theme) || 1;
  res.render('siann-17', { themeId: theme, layoutId: 17, showNav: false });
});

// 시안 레이아웃별 라우트 (기존 유지)
app.get('/siann/:n', (req, res) => {
  const n = parseInt(req.params.n) || 1;
  res.render('siann', { themeId: n });
});
app.get('/siann-:layout(\\d+)/:theme(\\d+)?', (req, res) => {
  const layout = Math.min(Math.max(parseInt(req.params.layout) || 1, 1), 99);
  const theme  = Math.min(Math.max(parseInt(req.params.theme)  || 1, 1), 30);
  res.render(`siann-${layout}`, { themeId: theme, layoutId: layout, showNav: false });
});

// /archive → 아카이브 페이지
app.get('/archive', (req, res) => res.render('archive'));

// /chat → AI 챗봇 페이지
app.get('/chat', (req, res) => res.render('chat'));

// /editor → SmartEditor2 (standalone 편집 전용 — 메인은 siann-22 통합)
app.get('/editor', (req, res) => res.render('editor'));

// ════════════════════════════════════════════════════════════════
//  ARCHIVE API  (from hanul-board)
// ════════════════════════════════════════════════════════════════

app.get('/api/boards', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT board, COUNT(*) as count FROM yeouiseonwon.posts GROUP BY board ORDER BY count DESC'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/posts', async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;
    const board  = req.query.board  || null;
    const search = req.query.search || null;

    const where = []; const params = []; let idx = 1;
    if (board)  { where.push(`p.board = $${idx++}`); params.push(board); }
    if (search) { where.push(`(p.title ILIKE $${idx} OR p.content ILIKE $${idx} OR p.author ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM yeouiseonwon.posts p ${wc}`, params)).rows[0].count);
    const rows  = (await pool.query(
      `SELECT p.id, p.post_id, p.board, p.title, p.author,
              LEFT(p.content, 200) as preview, p.created_at, p.image_urls,
              COALESCE(c.cnt, 0) as comment_count
       FROM yeouiseonwon.posts p
       LEFT JOIN (SELECT post_id, COUNT(*) cnt FROM yeouiseonwon.comments GROUP BY post_id) c ON c.post_id = p.post_id
       ${wc} ORDER BY p.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    )).rows;
    res.json({ posts: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/posts/:postId', async (req, res) => {
  try {
    const post = await pool.query('SELECT * FROM yeouiseonwon.posts WHERE post_id = $1', [req.params.postId]);
    if (!post.rows.length) return res.status(404).json({ error: 'Not found' });
    const comments = await pool.query(
      'SELECT * FROM yeouiseonwon.comments WHERE post_id = $1 ORDER BY created_at ASC',
      [req.params.postId]
    );
    res.json({ ...post.rows[0], comments: comments.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/posts/:postId', async (req, res) => {
  try {
    const { content_html, title } = req.body;
    if (!content_html) return res.status(400).json({ error: 'content_html required' });
    const text = content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    await pool.query(
      `UPDATE yeouiseonwon.posts SET content_html=$2, content=$3, title=COALESCE(NULLIF($4,''),title), crawled_at=NOW() WHERE post_id=$1`,
      [req.params.postId, content_html, text, title || '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [posts, wc, cmt, dr] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM yeouiseonwon.posts'),
      pool.query("SELECT COUNT(*) FROM yeouiseonwon.posts WHERE content IS NOT NULL AND content != ''"),
      pool.query('SELECT COUNT(*) FROM yeouiseonwon.comments'),
      pool.query('SELECT MIN(created_at) oldest, MAX(created_at) newest FROM yeouiseonwon.posts'),
    ]);
    res.json({
      totalPosts: parseInt(posts.rows[0].count),
      postsWithContent: parseInt(wc.rows[0].count),
      totalComments: parseInt(cmt.rows[0].count),
      oldestPost: dr.rows[0].oldest,
      newestPost: dr.rows[0].newest,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  AI CHATBOT API  (OpenAI embedding + pgvector)
// ════════════════════════════════════════════════════════════════

// ── AI 챗봇: OpenAI 임베딩 + pgvector RAG (즉시 응답) ──────────
app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const openai = getOpenAI();

    // 1) 임베딩 (캐시 우선 — Map 1시간 TTL, 최대 1000건)
    const vecStr = await getEmbedding(question);

    // 2) 키워드 추출 — 단어 단위 접미사 제거 + 질문용 불용어 제거
    const suffixRe = /(이란|란|이란요|이에요|입니까|합니까|인가요|이죠|이냐|이며|이고|이지|이다|이에|에서|으로|이요|가요|까요|이가|이는|이를|은요|는요|을까|이란말|란게|란말)$/;
    const stopWords = new Set(['무엇','어떤','어떻게','알려','주세요','설명','대해','관련','좀','어디','여기','저기','뭔가','무슨','왜','언제','누구','어디서','어떤','어떠']);
    const koreanRe = /[\uAC00-\uD7AF]{2,}/;
    const keywords = question
      .replace(/[?？！!.,。、]/g, '')
      .split(/\s+/)
      .map(w => w.replace(suffixRe, '').trim())
      .filter(w => w.length >= 2 && koreanRe.test(w) && !stopWords.has(w))
      .sort((a,b) => b.length - a.length)
      .slice(0, 3);
    const mainKeyword = keywords[0] || question.replace(/[?？！!.,。、\s]/g,'').slice(0, 6);

    // 3) 3중 하이브리드 검색: 게시글 pgvector + 게시글 키워드 + 경전(book_chunks) pgvector
    // OR → AND: 모든 키워드를 포함하는 게시글만 반환 (오탐 방지)
    const postKeywordWhere = keywords.length > 1
      ? keywords.map((_,i) => `(content ILIKE $${i+1} OR title ILIKE $${i+1})`).join(' AND ')
      : `(content ILIKE $1 OR title ILIKE $1)`;
    const postKeywordParams = keywords.length > 1
      ? keywords.map(k => `%${k.replace(/[%_]/g,'\\$&')}%`)
      : [`%${mainKeyword.replace(/[%_]/g,'\\$&')}%`];

    // 경전은 OR 조건 (하나라도 포함되면 검색)
    const bookKeywordWhere = keywords.length > 1
      ? keywords.map((_,i) => `chunk_text ILIKE $${i+1}`).join(' OR ')
      : `chunk_text ILIKE $1`;

    const [postsByVec, postsByKw, booksByVec, booksByKw] = await Promise.all([
      // (A) 게시글 pgvector (임베딩 있는 건만)
      pool.query(
        `SELECT id, title, LEFT(content, 1000) AS excerpt, board, created_at,
                1-(embedding <=> $1::vector) AS similarity
         FROM yeouiseonwon.posts
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT 8`,
        [vecStr]
      ).catch(() => ({ rows: [] })),
      // (B) 게시글 키워드 검색 (임베딩 유무 무관)
      pool.query(
        `SELECT id, title, LEFT(content, 1000) AS excerpt, board, created_at
         FROM yeouiseonwon.posts
         WHERE (${postKeywordWhere}) AND content IS NOT NULL AND content != ''
         ORDER BY created_at DESC LIMIT 8`,
        postKeywordParams
      ).catch(() => ({ rows: [] })),
      // (C) 경전 pgvector (book_chunks)
      pool.query(
        `SELECT id, book_name, chunk_index, LEFT(chunk_text, 800) AS excerpt,
                1-(embedding <=> $1::vector) AS similarity
         FROM yeouiseonwon.book_chunks
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT 5`,
        [vecStr]
      ).catch(() => ({ rows: [] })),
      // (D) 경전 키워드 검색
      pool.query(
        `SELECT id, book_name, chunk_index, LEFT(chunk_text, 800) AS excerpt
         FROM yeouiseonwon.book_chunks
         WHERE (${bookKeywordWhere}) AND chunk_text IS NOT NULL
         ORDER BY chunk_index ASC LIMIT 5`,
        postKeywordParams
      ).catch(() => ({ rows: [] })),
    ]);

    // 게시글: pgvector 0.35+ 결과 + 키워드 결과 합치고, 중복 제거 후 상위 8건
    const seenTitles = new Set();
    const allPosts = [];
    for (const r of postsByVec.rows) {
      if (r.similarity >= 0.35 && !seenTitles.has(r.title)) {
        seenTitles.add(r.title);
        allPosts.push({ ...r, source: 'vec' });
      }
    }
    for (const r of postsByKw.rows) {
      if (!seenTitles.has(r.title)) {
        seenTitles.add(r.title);
        allPosts.push({ ...r, source: 'kw' });
      }
    }
    const usePosts = allPosts.slice(0, 6);

    // 경전: pgvector 0.35+ + 키워드 결과, 중복 제거 후 상위 4건
    const seenBooks = new Set();
    const allBooks = [];
    for (const r of booksByVec.rows) {
      const key = `${r.book_name}-${r.chunk_index}`;
      if (r.similarity >= 0.30 && !seenBooks.has(key)) {
        seenBooks.add(key);
        allBooks.push({ ...r, source: 'vec' });
      }
    }
    for (const r of booksByKw.rows) {
      const key = `${r.book_name}-${r.chunk_index}`;
      if (!seenBooks.has(key)) {
        seenBooks.add(key);
        allBooks.push({ ...r, source: 'kw' });
      }
    }
    const useBooks = allBooks.slice(0, 4);

    // 디버그: 키워드 + 결과 수 로그
    console.log(`[chat-debug] q="${question}" kw=[${keywords}] main="${mainKeyword}" vecPosts=${postsByVec.rows.filter(r=>r.similarity>=0.35).length} kwPosts=${postsByKw.rows.length} merged=${usePosts.length} books=${useBooks.length}`);

    const postContext = usePosts.length
      ? '[여의선원 카페 게시글 — 법문 및 수행 기록]\n' + usePosts.map((r,i) =>
          `[게시글${i+1}] (${r.board} · ${r.title})\n${r.excerpt}`
        ).join('\n\n')
      : '';
    const bookContext = useBooks.length
      ? '[한울영성 경전 자료]\n' + useBooks.map((r,i) =>
          `[경전${i+1}] (${r.book_name} · ${r.chunk_index}번째 단락)\n${r.excerpt}`
        ).join('\n\n')
      : '';
    const context = [postContext, bookContext].filter(Boolean).join('\n\n');

    // 4) GPT 답변 — SSE 스트리밍 (gpt-4o 고품질)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sources = [
      ...usePosts.slice(0, 3).map(r => ({ type: 'post', id: r.id, title: r.title, board: r.board })),
      ...useBooks.slice(0, 2).map(r => ({ type: 'book', id: r.id, title: r.book_name, board: '경전' })),
    ];
    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [
        {
          role: 'system',
          content: [
            '당신은 여의선원(여의명상센터) 카페 아카이브 및 한울영성 경전 안내자입니다.',
            '여의선원 네이버 카페에 수십 년간 수집된 법문·수행 게시글과 한울영성 경전(한울말씀강론, 한울수행법, 한울수도법, 한울명상록, O의실체 등)을 기반으로 답변합니다.',
            '',
            '## ⚠️ 답변 범위 제한 (반드시 준수)',
            '- 오직 제공된 [게시글N] 및 [경전N] 자료에 근거하여 답변하세요.',
            '- 자료에 없는 내용은 "아카이브에서 관련 자료를 찾지 못했습니다"라고 안내하세요.',
            '- 여의선원 카페 게시글·경전 외 외부 지식으로 추론하거나 답변을 생성하지 마세요.',
            '- 타 종교(불교, 기독교, 도교 등)와의 비교 분석 요청은 거절하세요.',
            '- 거절 시: "해당 내용은 수련 프로그램 참여를 통해 직접 안내받으실 수 있습니다."로 안내하세요.',
            '',
            '## 답변 규칙',
            '1. 제공된 [게시글N] 및 [경전N] 자료를 최우선으로 활용하여 답변하세요.',
            '2. 원문을 직접 인용(따옴표)하며 구체적으로 설명하세요.',
            '3. 답변 끝에 출처([게시글N] 게시판명 · 제목 또는 [경전N] 경전명)를 반드시 밝히세요.',
            '4. 자료가 없으면 "아카이브에서 관련 자료를 찾지 못했습니다. 다른 키워드로 검색해보세요."라고 답변하세요.',
            '5. 친절하고 명확하게 답변하세요.',
            '6. 답변은 마크다운 형식으로 작성하세요: **굵게**, > 인용, - 목록 등을 활용하세요.',
            '7. 영어로 질문이 들어오면 영어로 답변하세요. 한국어 질문은 한국어로 답변하세요.',
          ].join('\n'),
        },
        { role: 'user', content: `## 참고 자료\n${context || '(관련 자료 없음)'}\n\n## 질문\n${question}` },
      ],
      max_tokens: 1800,
    });

    pool.query(
      'INSERT INTO yeouiseonwon.chat_questions (question, answered) VALUES ($1, TRUE)',
      [question]
    ).catch(() => {});

    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify({ type: 'token', text: delta })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (e) {
    console.error('[chat]', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      res.end();
    }
  }
});

// ── 담당관 답변 저장 (hanul-aide가 호출) ──
app.post('/api/chat/answers', async (req, res) => {
  try {
    const { questionId, answer, agentId } = req.body;
    if (!questionId || !answer) return res.status(400).json({ error: 'questionId and answer required' });
    await pool.query(
      'INSERT INTO yeouiseonwon.chat_answers (question_id, answer, agent_id) VALUES ($1, $2, $3)',
      [questionId, answer, agentId || 'hanul-aide']
    );
    await pool.query('UPDATE yeouiseonwon.chat_questions SET answered=TRUE WHERE id=$1', [questionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 답변 폴링 ──
app.get('/api/chat/answers', async (req, res) => {
  try {
    const { questionId } = req.query;
    if (!questionId) return res.status(400).json({ error: 'questionId required' });
    const r = await pool.query(
      'SELECT * FROM yeouiseonwon.chat_answers WHERE question_id=$1 ORDER BY answered_at DESC LIMIT 1',
      [questionId]
    );
    if (!r.rows.length) return res.json({ pending: true });
    res.json({ pending: false, answer: r.rows[0].answer, agentId: r.rows[0].agent_id, answeredAt: r.rows[0].answered_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  IMAGE PROXY & UPLOAD
// ════════════════════════════════════════════════════════════════

app.get('/api/img-proxy', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('missing url');
  const allowed = ['postfiles.pstatic.net', 'cafeptthumb-phinf.pstatic.net', 'cafeptthumb.pstatic.net', 'blogfiles.pstatic.net', 'pstatic.net'];
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).send('invalid url'); }
  if (!allowed.some(d => parsedUrl.hostname.endsWith(d))) return res.status(403).send('domain not allowed');
  const client2 = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: { 'Referer': 'https://cafe.naver.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };
  client2.get(options, (imgRes) => {
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', (e) => res.status(502).send(e.message));
});

// 에디터 디버그 로그 수신 — 클라이언트 이벤트를 PM2 로그로 기록 (Inspector/dev-3 실시간 확인용)
const _dbgLogs = [];
app.post('/api/editor-debug-log', (req, res) => {
  try {
    const { event, data, ts } = req.body || {};
    const line = `[EDITOR-DBG] ${ts || new Date().toISOString()} event=${event} ${JSON.stringify(data || {})}`;
    console.log(line);
    _dbgLogs.push({ ts: ts || Date.now(), event, data });
    if (_dbgLogs.length > 200) _dbgLogs.shift();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/editor-debug-log', (req, res) => {
  res.json(_dbgLogs.slice(-50));
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (req.file && req.file.path && !hasCloudinary) {
      return res.json({ url: `/public/uploads/${path.basename(req.file.path)}` });
    }
    if (req.file && req.file.path && hasCloudinary) {
      return res.json({ url: req.file.path || req.file.secure_url });
    }
    const { dataUrl } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'No dataUrl' });
    if (hasCloudinary) {
      const r = await cloudinary.uploader.upload(dataUrl, { folder: 'Hanwool', public_id: uuidv4(), resource_type: 'image' });
      return res.json({ url: r.secure_url });
    } else {
      const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
      if (!match) return res.status(400).json({ error: 'Invalid data URL' });
      const ext = match[1].split('/')[1] || 'png';
      const name = `${uuidv4()}.${ext}`;
      const dest = path.join(__dirname, '..', 'public', 'uploads');
      const fsp = await import('fs/promises');
      await fsp.mkdir(dest, { recursive: true });
      await fsp.writeFile(path.join(dest, name), Buffer.from(match[2], 'base64'));
      return res.json({ url: `/public/uploads/${name}` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── 네이버 OAuth 2.0 ──────────────────────────────────────────

// 로그인 시작 (CSRF state 생성 → 네이버 인증 페이지 리디렉트)
app.get('/auth/naver/login', (req, res) => {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    return res.status(503).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>네이버 로그인 준비 중</h2><p>서비스 설정이 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.</p><a href="/">홈으로</a></body></html>');
  }
  const state = uuidv4();
  req.session.oauthState = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.NAVER_CLIENT_ID,
    redirect_uri: process.env.NAVER_CALLBACK_URL || `http://localhost:${PORT}/auth/naver/callback`,
    state,
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params}`);
});

// 콜백 (code → access_token 교환 → 프로필 조회 → 세션+DB 저장)
app.get('/auth/naver/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || state !== req.session.oauthState) return res.status(403).send('CSRF 검증 실패');

    const tokenUrl = new URL('https://nid.naver.com/oauth2.0/token');
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    tokenUrl.searchParams.set('client_id', process.env.NAVER_CLIENT_ID || '');
    tokenUrl.searchParams.set('client_secret', process.env.NAVER_CLIENT_SECRET || '');
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('state', state);

    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json();
    if (tokenData.error) return res.status(400).json(tokenData);

    const profileResp = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profileData = await profileResp.json();
    const p = profileData.response;

    req.session.user = {
      id: p.id, name: p.name, email: p.email,
      nickname: p.nickname, profile_image: p.profile_image,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
    };

    await pool.query(`
      INSERT INTO yeouiseonwon.users (naver_id, name, email, nickname, profile_image, access_token, refresh_token, last_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (naver_id) DO UPDATE SET
        access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, last_login=NOW()
    `, [p.id, p.name, p.email, p.nickname, p.profile_image, tokenData.access_token, tokenData.refresh_token]);

    res.redirect('/');
  } catch (e) {
    console.error('[naver-callback]', e.message);
    res.status(500).send('로그인 처리 중 오류가 발생했습니다.');
  }
});

// 로그아웃
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// 현재 로그인 사용자 정보
app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session?.user || null });
});

// ── 온라인 신청 폼 ──────────────────────────────────────────────
app.post('/api/apply', async (req, res) => {
  try {
    const { name, phone, email, program, message } = req.body;
    if (!name || !phone || !program) {
      return res.status(400).json({ ok: false, error: '필수 항목을 입력해주세요.' });
    }
    await pool.query(
      `CREATE TABLE IF NOT EXISTS yeouiseonwon.applications (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        program TEXT NOT NULL,
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
    await pool.query(
      `INSERT INTO yeouiseonwon.applications (name, phone, email, program, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, phone, email || '', program, message || '']
    );
    console.log(`[신청접수] ${name} / ${phone} / ${program}`);
    res.json({ ok: true, message: '신청이 접수되었습니다. 담당자가 연락드리겠습니다.' });
  } catch (err) {
    console.error('[/api/apply]', err);
    res.status(500).json({ ok: false, error: '신청 처리 중 오류가 발생했습니다.' });
  }
});

// ════════════════════════════════════════════════════════════════
//  네이버페이 결제 API (PortOne 연동)
// ════════════════════════════════════════════════════════════════
app.use('/api/payment', createPaymentRouter(pool));

// 결제 완료 페이지
app.get('/payment/success', (req, res) => {
  res.render('payment-success', {
    merchantUid: req.query.uid || '',
  });
});

// 결제 실패 페이지
app.get('/payment/fail', (req, res) => {
  res.render('payment-fail', {
    errorMsg: req.query.msg || '결제에 실패했습니다.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`한울사상 통합 서버 http://0.0.0.0:${PORT}`);
  console.log('  /        — A팀 홈페이지 (siann-22)');
  console.log('  /v2      — B팀 홈페이지 (siann-17)');
  console.log('  /archive — 아카이브');
  console.log('  /chat    — AI 챗봇');
  console.log(`[EmbCache] 초기화 완료 — TTL=${EMB_CACHE_TTL/60000}분 / 최대 ${EMB_CACHE_MAX}건`);
  console.log('  /editor  — SmartEditor2 standalone (포트 8082는 server-editor.js)');
  console.log('  /api/payment — 네이버페이 결제 API (PortOne)');
});
