/**
 * hanul-editor access & post action logger
 * Clean Architecture: 로깅 로직 완전 분리. 서버 코드는 logger 호출만.
 * - DB 장애 시 파일 폴백 (운영 중단 없음)
 * - 모든 DB 호출은 fire-and-forget (await 없음, 요청 처리 차단 없음)
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';

// ── DB 풀 (shared) ──
const pool = new pg.Pool({
  host: 'localhost', port: 5432,
  database: 'hanul_thought',
  user: 'postgres', password: 'postgres',
  max: 3, idleTimeoutMillis: 30000,
});

// ── 파일 폴백 경로 ──
const LOG_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function _fileLog(filename, data) {
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, filename),
      JSON.stringify(data) + '\n',
      'utf8'
    );
  } catch (_) {}
}

// ── DB 자동 테이블 초기화 ──
async function _initTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS yeouiseonwon.access_logs (
        id          SERIAL PRIMARY KEY,
        accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip          TEXT,
        method      TEXT,
        path        TEXT,
        user_agent  TEXT,
        referer     TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS yeouiseonwon.post_action_logs (
        id        SERIAL PRIMARY KEY,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip        TEXT,
        action    TEXT,
        post_id   TEXT,
        board     TEXT,
        title     TEXT
      )
    `);
    console.log('[logger] DB 테이블 초기화 완료');
  } catch (e) {
    console.warn('[logger] DB 초기화 실패 (파일 폴백 사용):', e.message);
  }
}
_initTables();

/**
 * Express 미들웨어 — 모든 요청 접속 로그
 * 정적 파일(/public, /uploads) 제외
 */
export function accessLogMiddleware(req, res, next) {
  // 정적 파일 제외
  if (req.path.startsWith('/public') || req.path.startsWith('/uploads')) {
    return next();
  }
  const data = {
    accessed_at: new Date().toISOString(),
    ip: req.ip || req.connection?.remoteAddress || 'unknown',
    method: req.method,
    path: req.path,
    user_agent: (req.headers['user-agent'] || '').slice(0, 300),
    referer: (req.headers['referer'] || '').slice(0, 200),
  };
  // fire-and-forget: 로깅이 요청 처리를 절대 지연시키지 않음
  pool.query(
    `INSERT INTO yeouiseonwon.access_logs (accessed_at, ip, method, path, user_agent, referer)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [data.accessed_at, data.ip, data.method, data.path, data.user_agent, data.referer]
  ).catch(() => _fileLog('access.log', data));
  next();
}

/**
 * 게시글 액션 로그 (조회 / 수정)
 * @param {Object} req - Express request
 * @param {string} action - 'view' | 'update'
 * @param {Object} meta - { post_id, board, title }
 */
export function logPostAction(req, action, meta = {}) {
  const data = {
    logged_at: new Date().toISOString(),
    ip: req.ip || req.connection?.remoteAddress || 'unknown',
    action,
    post_id: meta.post_id || null,
    board: meta.board || null,
    title: (meta.title || '').slice(0, 200),
  };
  pool.query(
    `INSERT INTO yeouiseonwon.post_action_logs (logged_at, ip, action, post_id, board, title)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [data.logged_at, data.ip, data.action, data.post_id, data.board, data.title]
  ).catch(() => _fileLog('post-actions.log', data));
}

/**
 * 로그 조회 API 라우터 — GET /api/logs/access, /api/logs/post-actions
 * 운영자 전용 (별도 인증 없이 내부 사용 가정)
 */
export function registerLogRoutes(app) {
  // 접속 로그 목록
  app.get('/api/logs/access', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const offset = parseInt(req.query.offset) || 0;
      const rows = await pool.query(
        `SELECT * FROM yeouiseonwon.access_logs ORDER BY accessed_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const total = parseInt((await pool.query('SELECT COUNT(*) FROM yeouiseonwon.access_logs')).rows[0].count);
      res.json({ logs: rows.rows, total, limit, offset });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 게시글 액션 로그 목록
  app.get('/api/logs/post-actions', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const offset = parseInt(req.query.offset) || 0;
      const action = req.query.action || null;
      const where = action ? 'WHERE action=$3' : '';
      const params = action ? [limit, offset, action] : [limit, offset];
      const rows = await pool.query(
        `SELECT * FROM yeouiseonwon.post_action_logs ${where} ORDER BY logged_at DESC LIMIT $1 OFFSET $2`,
        params
      );
      const totalQ = action
        ? await pool.query('SELECT COUNT(*) FROM yeouiseonwon.post_action_logs WHERE action=$1', [action])
        : await pool.query('SELECT COUNT(*) FROM yeouiseonwon.post_action_logs');
      res.json({ logs: rows.rows, total: parseInt(totalQ.rows[0].count), limit, offset });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 요약 대시보드
  app.get('/api/logs/summary', async (req, res) => {
    try {
      const [acc, post, today, recent] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM yeouiseonwon.access_logs'),
        pool.query('SELECT COUNT(*) FROM yeouiseonwon.post_action_logs'),
        pool.query(`SELECT COUNT(*) FROM yeouiseonwon.access_logs WHERE accessed_at > NOW() - INTERVAL '24h'`),
        pool.query(`SELECT action, COUNT(*) cnt FROM yeouiseonwon.post_action_logs GROUP BY action`),
      ]);
      res.json({
        access_total: parseInt(acc.rows[0].count),
        post_action_total: parseInt(post.rows[0].count),
        access_last_24h: parseInt(today.rows[0].count),
        post_action_by_type: Object.fromEntries(recent.rows.map(r => [r.action, parseInt(r.cnt)])),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
