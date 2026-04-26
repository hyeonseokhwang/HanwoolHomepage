import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { accessLogMiddleware, logPostAction, registerLogRoutes } from './logger.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 로컬 업로드 디렉토리 — 시작 시 존재+쓰기 권한 확인 ──
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  // 쓰기 권한 확인: 임시 파일 생성 후 삭제
  const testFile = path.join(UPLOADS_DIR, `.write-test-${Date.now()}`);
  fs.writeFileSync(testFile, '');
  fs.unlinkSync(testFile);
  console.log('[upload] /uploads/ 디렉토리 확인 완료:', UPLOADS_DIR);
} catch (e) {
  console.error('[upload] FATAL: /uploads/ 디렉토리 쓰기 불가 —', e.message);
  process.exit(1);
}

// ── Multer 로컬 저장 설정 (Cloudinary 제거 — Phase 2) ──
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const PORT = process.env.EDITOR_PORT_V2 || 9082;

// ── lucasinit.duckdns.org 접속 시 LI 공식 홈페이지로 리다이렉트 ──
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'lucasinit.duckdns.org') {
    return res.redirect(301, 'http://lucasinit.duckdns.org:8181/lucas-homepage/');
  }
  next();
});

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));  // Phase 1: /uploads/{uuid}.ext 직접 접근

// ── 접속 로그 미들웨어 (클린 아키텍처: logger 모듈에 위임) ──
app.use(accessLogMiddleware);

app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'ejs');
app.set('view cache', false);

const pool = new pg.Pool({
  host: 'localhost', port: 5432,
  database: 'hanul_thought',
  user: 'postgres', password: 'postgres',
});

// GET / → 스마트에디터 2.0으로 redirect (Lucas님 지시: 9082는 에디터 전용)
app.get('/', (req, res) => res.redirect('/editor'));
// 에디터 직접 접근
app.get('/editor', (req, res) => res.render('editor-v2'));

// 게시글 조회 (에디터용)
app.get('/api/posts', async (req, res) => {
  try {
    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;
    const board  = req.query.board  || null;
    const search = req.query.search || null;

    const where = []; const params = []; let idx = 1;
    if (board)  { where.push(`board = $${idx++}`); params.push(board); }
    if (search) { where.push(`(title ILIKE $${idx} OR content ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM yeouiseonwon.posts ${wc}`, params)).rows[0].count);
    const rows  = (await pool.query(
      `SELECT id, post_id, board, title, author, LEFT(content,200) preview, created_at
       FROM yeouiseonwon.posts ${wc} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    )).rows;
    res.json({ posts: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/posts/:postId', async (req, res) => {
  try {
    const post = await pool.query('SELECT * FROM yeouiseonwon.posts WHERE post_id = $1', [req.params.postId]);
    if (!post.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = post.rows[0];
    // 게시글 조회 로그 (fire-and-forget)
    logPostAction(req, 'view', { post_id: row.post_id, board: row.board, title: row.title });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/posts/:postId', async (req, res) => {
  try {
    const { content_html, title } = req.body;
    if (!content_html) return res.status(400).json({ error: 'content_html required' });
    const text = content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 기존 board 조회 (로그용)
    const existing = await pool.query('SELECT board, title FROM yeouiseonwon.posts WHERE post_id=$1', [req.params.postId]);
    await pool.query(
      `UPDATE yeouiseonwon.posts SET content_html=$2, content=$3, title=COALESCE(NULLIF($4,''),title), crawled_at=NOW() WHERE post_id=$1`,
      [req.params.postId, content_html, text, title || '']
    );
    // 게시글 수정 로그 (fire-and-forget)
    const meta = existing.rows[0] || {};
    logPostAction(req, 'update', { post_id: req.params.postId, board: meta.board, title: title || meta.title });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/boards', async (req, res) => {
  try {
    const r = await pool.query('SELECT board, COUNT(*) count FROM yeouiseonwon.posts GROUP BY board ORDER BY count DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Phase 1: 세션별 동시 업로드 semaphore (IP 기반, max 3) ──
const _uploadSem = new Map(); // ip → { count, queue[] }
const MAX_UPLOAD_CONCURRENT = 3;
async function _semAcquire(ip) {
  if (!_uploadSem.has(ip)) _uploadSem.set(ip, { count: 0, queue: [] });
  const s = _uploadSem.get(ip);
  if (s.count < MAX_UPLOAD_CONCURRENT) { s.count++; return; }
  await new Promise(resolve => s.queue.push(resolve));
  s.count++;
}
function _semRelease(ip) {
  const s = _uploadSem.get(ip);
  if (!s) return;
  s.count = Math.max(0, s.count - 1);
  if (s.queue.length > 0) s.queue.shift()();
}

// 이미지 업로드 (multer 파일 또는 base64 dataUrl) — Phase 2: 로컬 저장 전용 (Cloudinary 제거)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const ip = req.ip || 'unknown';
  await _semAcquire(ip);
  try {
    // multer 파일 업로드
    if (req.file) {
      return res.json({ url: `/uploads/${req.file.filename}` });
    }

    // 로컬 파일 경로 업로드 (레거시 filePath 경로 — 보안 제한 유지)
    const { filePath } = req.body;
    if (filePath && typeof filePath === 'string') {
      let cleanPath = filePath;
      if (cleanPath.startsWith('file:///')) {
        cleanPath = cleanPath.slice(8);
        if (cleanPath.startsWith('/')) cleanPath = cleanPath.slice(1);
        cleanPath = cleanPath.replace(/\//g, '\\');
      }
      const resolved = path.resolve(cleanPath);
      const tempDir = path.resolve(process.env.TEMP || process.env.TMP || 'C:\\Users\\hysra\\AppData\\Local\\Temp');
      if (!resolved.startsWith(tempDir)) return res.status(403).json({ error: 'filePath must be in temp directory' });
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found: ' + path.basename(resolved) });
      const ext = path.extname(resolved).replace('.', '') || 'jpg';
      const name = `${uuidv4()}.${ext}`;
      fs.copyFileSync(resolved, path.join(UPLOADS_DIR, name));
      return res.json({ url: `/uploads/${name}` });
    }

    // base64 dataUrl 업로드 — 로컬 저장 전용
    const { dataUrl } = req.body;
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'No file or dataUrl' });
    }

    // 비지원 포맷 조기 거부
    const mimeMatch = dataUrl.match(/^data:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1].toLowerCase() : '';
    const unsupportedFmts = ['image/x-wmf', 'image/wmf', 'image/x-emf', 'image/emf', 'image/x-bmp'];
    if (unsupportedFmts.includes(mime) || (mime && !mime.startsWith('image/'))) {
      return res.status(400).json({ error: `Unsupported image format: ${mime}` });
    }

    const match = dataUrl.match(/^data:(.*?);base64,(.*)$/s);
    if (!match) return res.status(400).json({ error: 'Invalid data URL' });
    const ext = (match[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').substring(0, 10);
    const name = `${uuidv4()}.${ext}`;
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(match[2], 'base64'));
      console.log('[upload] local OK:', name);
      return res.json({ url: `/uploads/${name}` });
    } catch (localErr) {
      console.error('[upload] local save failed:', localErr.message);
      return res.status(500).json({ error: 'Upload failed: ' + localErr.message });
    }
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: 'Upload failed' });
  } finally {
    _semRelease(ip);
  }
});

// 클립보드 분석 데이터 수신 — Lucas 직접 지시: 에이전트가 클립보드 데이터를 읽을 수 있도록
const CLIP_LOG_DIR = path.join(__dirname, '..', 'public', 'clipboard-logs');
if (!fs.existsSync(CLIP_LOG_DIR)) fs.mkdirSync(CLIP_LOG_DIR, { recursive: true });

app.post('/api/log/clipboard', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `clip-${ts}.json`;
    const data = {
      timestamp: new Date().toISOString(),
      ...req.body,
    };
    fs.writeFileSync(path.join(CLIP_LOG_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
    console.log('[clipboard] logged:', filename, '| htmlLen:', req.body.htmlLen, '| rtfLen:', req.body.rtfLen, '| images:', req.body.fileImgCount);
    res.json({ ok: true, filename });
  } catch (err) {
    console.error('[clipboard]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/log/clipboard', (req, res) => {
  try {
    const files = fs.readdirSync(CLIP_LOG_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    if (req.query.latest) {
      if (!files.length) return res.json({ error: 'no logs' });
      const data = JSON.parse(fs.readFileSync(path.join(CLIP_LOG_DIR, files[0]), 'utf8'));
      return res.json(data);
    }
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 이미지 감사 API — GET /api/posts/:postId/image-audit
app.get('/api/posts/:postId/image-audit', async (req, res) => {
  try {
    const post = await pool.query('SELECT content_html FROM yeouiseonwon.posts WHERE post_id = $1', [req.params.postId]);
    if (!post.rows.length) return res.status(404).json({ error: 'Not found' });
    const html = post.rows[0].content_html || '';
    const details = [];
    const imgTagRe = /<img\b([^>]*)>/gi;
    let m;
    while ((m = imgTagRe.exec(html)) !== null) {
      const srcM = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(m[1]);
      const src = srcM ? srcM[1] : '';
      let status;
      if (!src) status = 'broken';
      else if (/^https?:\/\//i.test(src)) status = 'uploaded';
      else status = 'pending';
      const preview = src.length > 120 ? src.slice(0, 120) + '…' : src;
      details.push({ src: preview, status });
    }
    const total    = details.length;
    const uploaded = details.filter(d => d.status === 'uploaded').length;
    const pending  = details.filter(d => d.status === 'pending').length;
    const broken   = details.filter(d => d.status === 'broken').length;
    res.json({ total, uploaded, pending, broken, details });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 클립보드 디버그 로그 — 전체 데이터 메모리 저장 + 파일 백업
const CLIPBOARD_LOG_DIR = path.join(__dirname, '..', 'public', 'clipboard-logs');
fs.mkdirSync(CLIPBOARD_LOG_DIR, { recursive: true });
let lastClipboardData = null;

app.post('/api/log/clipboard', (req, res) => {
  const body = req.body;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  lastClipboardData = { ts, ...body };
  // 파일 저장 (base64 데이터 포함 전체)
  const fpath = path.join(CLIPBOARD_LOG_DIR, `clipboard-${ts}.json`);
  try { fs.writeFileSync(fpath, JSON.stringify(lastClipboardData, null, 2)); } catch(e) {}
  console.log('[SE2][clipboard]', ts, '| htmlLen:', body.htmlLen, '| rtfLen:', body.rtfLen,
    '| fileImgs:', body.fileImgCount, '| hwpJson:', body.hwpJsonImages,
    '| rtf:', body.rtfImages, '| htmlData:', body.htmlDataImages,
    '| hwpMeta:', body.hwpMeta ? `bidt:${Object.keys(body.hwpMeta.bidtKeys||{}).length} srOrder:${(body.hwpMeta.srOrder||[]).length}` : 'none');
  res.json({ ok: true, saved: fpath });
});

// 클립보드 분석 조회 — GET /api/debug/clipboard
app.get('/api/debug/clipboard', (req, res) => {
  if (!lastClipboardData) {
    // 파일에서 가장 최근 것 로드
    try {
      const files = fs.readdirSync(CLIPBOARD_LOG_DIR).filter(f => f.endsWith('.json')).sort();
      if (files.length) {
        const latest = path.join(CLIPBOARD_LOG_DIR, files[files.length - 1]);
        lastClipboardData = JSON.parse(fs.readFileSync(latest, 'utf8'));
      }
    } catch(e) {}
  }
  if (!lastClipboardData) return res.status(404).json({ error: 'No clipboard data recorded yet' });
  const d = lastClipboardData;
  const meta = d.hwpMeta || {};
  const bidtKeys = Object.keys(meta.bidtKeys || {});
  const srOrder = meta.srOrder || [];
  const missingInBidt = srOrder.filter(sr => !meta.bidtKeys || meta.bidtKeys[sr] === undefined);
  res.json({
    ts: d.ts,
    htmlLen: d.htmlLen,
    rtfLen: d.rtfLen,
    fileImgCount: d.fileImgCount,
    fileUrlNames: d.fileUrlNames || [],
    sources: {
      hwpJson: d.hwpJsonImages,
      rtf: d.rtfImages,
      htmlData: d.htmlDataImages,
      clipboardFiles: d.clipboardFiles,
    },
    hwpMeta: {
      bidtKeyCount: bidtKeys.length,
      srOrderCount: srOrder.length,
      matched: meta.matched,
      missingInBidt,
      bidtKeys,
      srOrder,
    },
    analysis: {
      shortfall: (d.fileImgCount || 0) - (d.hwpJsonImages || 0),
      reason: missingInBidt.length > 0
        ? `HWP JSON bidt에 ${missingInBidt.length}개 키 없음 → file:/// 만 존재`
        : (d.fileImgCount || 0) > (d.hwpJsonImages || 0)
          ? 'HWP JSON 이미지 수 < file:/// 태그 수 — 대량 복사 한계'
          : 'OK',
    }
  });
});

// 클립보드 로우데이터 전체 저장 (진단용 — clipHTML + clipRTF 원본 포함)
app.post('/api/log/clipboard-raw', express.json({ limit: '200mb' }), (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `raw-${ts}.json`;
    const data = {
      timestamp: new Date().toISOString(),
      clipHTMLLen: (req.body.clipHTML || '').length,
      clipRTFLen: (req.body.clipRTF || '').length,
      imageCount: req.body.imageCount || 0,
      fileUrlCount: req.body.fileUrlCount || 0,
      clipHTML: req.body.clipHTML || '',
      clipRTF: req.body.clipRTF || '',
      clipText: (req.body.clipText || '').slice(0, 2000),
    };
    fs.writeFileSync(path.join(CLIPBOARD_LOG_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
    console.log('[clipboard-raw] saved:', filename, '| htmlLen:', data.clipHTMLLen, '| rtfLen:', data.clipRTFLen, '| fileUrls:', data.fileUrlCount);
    res.json({ ok: true, filename });
  } catch (err) {
    console.error('[clipboard-raw]', err);
    res.status(500).json({ error: err.message });
  }
});

// 최종 저장 로그
app.post('/api/log/final', (req, res) => {
  console.log('[SE2][final]', JSON.stringify(req.body).slice(0, 200));
  res.json({ verdict: 'pass' });
});

// 에디터 이미지 리사이즈 디버그 로그 (Inspector/dev-3 실시간 확인)
const _dbgLogs = [];
const _dbgCors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
app.post('/api/editor-debug-log', _dbgCors, express.json(), (req, res) => {
  const { event, data, ts } = req.body || {};
  const line = `[EDITOR-DBG] ${ts || new Date().toISOString()} event=${event} ${JSON.stringify(data || {})}`;
  console.log(line);
  _dbgLogs.push({ ts: ts || new Date().toISOString(), event, data });
  if (_dbgLogs.length > 200) _dbgLogs.shift();
  res.json({ ok: true });
});
app.get('/api/editor-debug-log', _dbgCors, (req, res) => {
  res.json(_dbgLogs.slice(-50));
});
app.options('/api/editor-debug-log', _dbgCors, (req, res) => res.sendStatus(204));

// ── 로그 조회 API 라우트 등록 (클린 아키텍처: logger 모듈에 위임) ──
registerLogRoutes(app);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[hanul-editor] 에디터 서버 포트 :${PORT}`);
  console.log(`  / → editor.ejs`);
  console.log(`  로그 API: GET /api/logs/access | /api/logs/post-actions | /api/logs/summary`);
});

// HTTP on port 80 (http://hanwool-board.duckdns.org/)
import https from 'https';
app.listen(80, '0.0.0.0', () => {
  console.log(`[hanul-editor] HTTP :80 (hanwool-board.duckdns.org)`);
}).on('error', (e) => {
  console.log('[hanul-editor] 포트 80 에러:', e.message);
});

// HTTPS on port 443 (https://hanwool-board.duckdns.org/)
try {
  const sslCertsDir = 'G:/Lucas-Initiative/WorkSpace/hanul-board/certs';
  const sslKey = fs.readFileSync(path.join(sslCertsDir, 'key.pem'));
  const sslCert = fs.readFileSync(path.join(sslCertsDir, 'cert.pem'));
  https.createServer({ key: sslKey, cert: sslCert }, app).listen(443, '0.0.0.0', () => {
    console.log(`[hanul-editor] HTTPS :443 (hanwool-board.duckdns.org)`);
  }).on('error', (e) => {
    console.log('[hanul-editor] 포트 443 에러:', e.message);
  });
} catch (e) {
  console.log('[hanul-editor] SSL 인증서 로드 실패:', e.message);
}
