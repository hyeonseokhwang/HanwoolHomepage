import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { accessLogMiddleware, logPostAction, registerLogRoutes } from './logger.js';
import { buildMobileEditorHtml } from './mobile-editor-page.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
dotenv.config({ path: 'G:\\Lucas-Initiative\\.env', override: false });

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
app.use('/public', express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); }
}));
app.use('/uploads', express.static(UPLOADS_DIR));  // Phase 1: /uploads/{uuid}.ext 직접 접근

// ── q72891 L1 LCC 핫라인 프록시 — hanul-editor 9082 → cc-webserver 9000 /api/lcc/* ──
// SRE q72891 위임. /api/lcc/* 6경로만 통과. 헤더(X-LCC-Token, X-Branch-Id, X-Agent-Id, X-Actor-Id) 보존. timeout 30s.
const LCC_UPSTREAM = process.env.LCC_UPSTREAM ?? 'http://localhost:9000';
async function lccProxy(req, res) {
  const upstreamPath = req.originalUrl; // /api/lcc/...
  const url = LCC_UPSTREAM + upstreamPath;
  try {
    const forwardHeaders = {};
    ['x-lcc-token', 'x-branch-id', 'x-agent-id', 'x-actor-id', 'content-type'].forEach(h => {
      const v = req.headers[h];
      if (v) forwardHeaders[h] = v;
    });
    const init = {
      method: req.method,
      headers: forwardHeaders,
      signal: AbortSignal.timeout(30000),
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = JSON.stringify(req.body ?? {});
    }
    const upstream = await fetch(url, init);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'content-encoding'].includes(k.toLowerCase())) res.setHeader(k, v);
    });
    res.end(buf);
  } catch (e) {
    console.error('[lcc-proxy] err:', e?.message ?? e);
    res.status(502).json({ ok: false, error: 'LCC_PROXY_UPSTREAM_FAIL', message: String(e?.message ?? e) });
  }
}
// L1 health (proxy /api/health)
app.get('/api/lcc/health', async (_req, res) => {
  try {
    const upstream = await fetch(LCC_UPSTREAM + '/api/health', { signal: AbortSignal.timeout(5000) });
    const j = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json({ ok: upstream.ok, l1: 'hanul-editor:9082', upstream: j });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'LCC_HEALTH_FAIL', message: String(e?.message ?? e) });
  }
});
// L1 -> L2 proxy for 5 LCC endpoints
app.use('/api/lcc/intake', express.json({ limit: '5mb' }), lccProxy);
app.use('/api/lcc/orders', express.json({ limit: '5mb' }), lccProxy);
app.use('/api/lcc/speak', express.json({ limit: '5mb' }), lccProxy);
app.use('/api/lcc/inbox', express.json({ limit: '5mb' }), lccProxy);
app.use('/api/lcc/ack-message', express.json({ limit: '5mb' }), lccProxy);
// L1 -> file sharing (3 routes, q73746/q73749)
async function lccStreamProxy(req, res) {
  const url = LCC_UPSTREAM + req.originalUrl;
  try {
    const fwdHeaders = {};
    ['x-lcc-token', 'x-branch-id', 'x-agent-id', 'x-actor-id', 'content-type', 'content-length'].forEach(h => {
      const v = req.headers[h];
      if (v) fwdHeaders[h] = v;
    });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const upstream = await fetch(url, { method: req.method, headers: fwdHeaders, body: rawBody, signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => { if (!['transfer-encoding', 'content-encoding'].includes(k.toLowerCase())) res.setHeader(k, v); });
    res.end(buf);
  } catch (e) {
    console.error('[lcc-stream-proxy] err:', e?.message ?? e);
    res.status(502).json({ ok: false, error: 'LCC_PROXY_UPSTREAM_FAIL', message: String(e?.message ?? e) });
  }
}
app.use('/api/lcc/files/upload', lccStreamProxy);
app.use('/api/lcc/files/download', lccProxy);
app.use('/api/lcc/files/list', lccProxy);

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
const ccPool = new pg.Pool({
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? '5432'),
  database: process.env.PG_DB ?? 'lucas_initiative',
  user: process.env.PG_USER ?? 'lucas',
  password: process.env.PG_PASSWORD ?? '',
});
const MOBILE_DATA_PATH = 'G:/Lucas-Initiative/agents/mentor/reports/lucas-directives-week-audit-20260623/lucas-directives-mobile-report-data-20260623.json';
const SNAPSHOT_9704_PATH = 'G:/Lucas-Initiative/command-center-v2/data/hq-ledger-9704-today/snapshot.json';
const LEDGER_EVENTS_PATH = 'G:/Lucas-Initiative/command-center-v2/data/hq-ledger-9704-today/events.jsonl';
const AGENT_ACTIVITY_PATH = 'G:/Lucas-Initiative/.coordination/activity-log/agent-activity.jsonl';
const AGENT_WS_UPSTREAM = 'ws://127.0.0.1:9710/ws/screen';
const PERSONA_MAP = {
  coo: '운영 총괄',
  cto: 'CTO 맥스',
  'dev-1': '개발 태오',
  mentor: '솔로몬 고문',
  arum: '아름 비서관',
  inspector: '감독관 럭스',
  'design-lead': '미르 디자인장',
  'design-3': '모바일 실무',
  lucas: 'Lucas',
};

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function readJsonSafe(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function readJsonlSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function kstString(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const byType = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} KST`;
}
function todayStartUtcMs() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  return Date.UTC(y, m, d, -9, 0, 0, 0);
}
function summaryFromText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
}
function extractCommitHashes(text) {
  const source = String(text ?? '');
  const hits = [];
  const regex = /(commit|커밋|hash)[^0-9a-f]{0,20}([0-9a-f]{7,40})/gi;
  let match;
  while ((match = regex.exec(source)) !== null) {
    hits.push(match[2].toLowerCase());
  }
  return [...new Set(hits)];
}
function statusClass(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('PROGRESS')) return 'in-progress';
  if (s.includes('REVIEW')) return 'review';
  if (s.includes('HOLD')) return 'hold';
  if (s.includes('DONE') || s.includes('CLOSED')) return 'done';
  return 'new';
}
function teamLabel(team, agentId = '') {
  const id = String(agentId || '').toLowerCase();
  if (/^dev-/.test(id) || id === 'cto' || id === 'sre' || id === 'hanul') return '개발';
  if (/^design-/.test(id)) return '디자인';
  if (id === 'inspector' || id === 'codex-agent') return '감독';
  if (id === 'research-lab' || id === 'trend-analyst' || /^codex-research-/.test(id)) return '연구';
  if (id === 'coo' || id === 'arum' || id === 'solomon' || id === 'mentor' || id === 'lucas') return '임원';
  const key = String(team || '').toLowerCase();
  if (key === 'audit') return '감독';
  if (key === 'design') return '디자인';
  if (key === 'research' || key === 'strategy') return '연구';
  if (key === 'dev' || key === 'infra') return '개발';
  return '임원';
}
function shortTask(text, fallback = '-') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 120) : fallback;
}
function formatDurationMinutes(totalSeconds) {
  const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}
function mergeActiveRanges(points, nowMs) {
  const windowMs = 15 * 60 * 1000;
  const ranges = [];
  for (const point of points) {
    const start = point;
    const end = Math.min(point + windowMs, nowMs);
    if (end <= start) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1]) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}
const mobileOpsSseClients = new Set();
let agentUpstreamWs = null;
let agentUpstreamReconnectTimer = null;
let mobileOpsBroadcastInFlight = false;

async function broadcastMobileOps(reason = 'push', meta = {}) {
  if (!mobileOpsSseClients.size || mobileOpsBroadcastInFlight) return;
  mobileOpsBroadcastInFlight = true;
  try {
    const payload = await buildMobileOpsPayload();
    const data = `event: snapshot\ndata: ${JSON.stringify({ reason, ...meta, payload })}\n\n`;
    for (const client of [...mobileOpsSseClients]) {
      try {
        client.write(data);
      } catch {
        mobileOpsSseClients.delete(client);
      }
    }
  } finally {
    mobileOpsBroadcastInFlight = false;
  }
}
function scheduleAgentUpstreamReconnect() {
  if (agentUpstreamReconnectTimer) return;
  agentUpstreamReconnectTimer = setTimeout(() => {
    agentUpstreamReconnectTimer = null;
    ensureAgentUpstreamWs();
  }, 2000);
}
function ensureAgentUpstreamWs() {
  if (agentUpstreamWs || !mobileOpsSseClients.size) return;
  const ws = new WebSocket(AGENT_WS_UPSTREAM);
  agentUpstreamWs = ws;
  ws.on('open', () => {
    try { ws.send(JSON.stringify({ type: 'subscribe', channel: 'agents' })); } catch {}
  });
  ws.on('message', async (raw) => {
    let upstreamMeta = {};
    try {
      const parsed = JSON.parse(String(raw));
      upstreamMeta = {
        upstreamType: parsed?.type || null,
        upstreamGeneratedAt: parsed?.generatedAt || null,
        upstreamReason: parsed?.reason || null,
      };
    } catch {}
    await broadcastMobileOps('ws-push', upstreamMeta);
  });
  ws.on('close', () => {
    if (agentUpstreamWs === ws) agentUpstreamWs = null;
    scheduleAgentUpstreamReconnect();
  });
  ws.on('error', () => {
    try { ws.close(); } catch {}
  });
}
async function fetchAgentStatuses() {
  let agents9710 = [];
  let workers9000 = [];
  try {
    const response = await fetch('http://127.0.0.1:9710/api/agents', { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const json = await response.json();
      agents9710 = Array.isArray(json.items) ? json.items : [];
    }
  } catch {}
  try {
    const response = await fetch('http://127.0.0.1:9000/api/workers', { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const json = await response.json();
      workers9000 = Array.isArray(json) ? json : [];
    }
  } catch {}
  const byId = new Map();
  for (const item of workers9000) {
    if (item?.id) byId.set(item.id, item);
  }
  const primary = agents9710.length ? agents9710 : workers9000;
  return primary.map((item) => {
    const workerMeta = byId.get(item.id) || {};
    const persona = item.persona || workerMeta.persona || workerMeta.name || PERSONA_MAP[item.id] || '에이전트';
    const state = String(item.state || workerMeta.state || item.taskState || workerMeta.taskState || 'idle').toLowerCase() === 'working' ? 'working' : 'idle';
    const currentTaskRaw =
      item.currentTask
      || workerMeta.currentTask
      || workerMeta.currentTaskTitle
      || workerMeta.statusNote
      || workerMeta.pursuingGoal?.title
      || workerMeta.ledgerCurrentTaskTitle
      || '-';
    const currentTask = shortTask(
      currentTaskRaw
    );
    const previousTaskRaw =
      item.previousTask
      || workerMeta.previousTask
      || workerMeta.ledgerCurrentTaskTitle
      || '-';
    const previousTask = shortTask(
      previousTaskRaw,
      '-'
    );
    const lastSelfUpdateRaw =
      item.last_self_update
      || workerMeta.last_self_update
      || item.updatedAt
      || workerMeta.updatedAt
      || null;
    const lastActiveAt = kstString(
      lastSelfUpdateRaw
      || workerMeta.terminalActivity?.lastMeaningfulChangeAt
      || workerMeta.terminalActivity?.lastLogAt
      || workerMeta.previousTaskAt
      || null
    );
    const rawTeam = workerMeta.team || item.team || workerMeta.type || item.type || 'executive';
    return {
      id: item.id,
      persona,
      state,
      currentTask,
      currentTaskRaw,
      previousTask,
      previousTaskRaw,
      lastActiveAt,
      last_self_update: lastSelfUpdateRaw,
      team: teamLabel(rawTeam, item.id),
      source: agents9710.length ? '9710+9000' : '9000',
    };
  });
}
async function buildMobileOpsPayload() {
  // 9704 snapshot에서 직접 읽기 (live SoT)
  const snap9704 = readJsonSafe(SNAPSHOT_9704_PATH, {});
  const snapItems = Array.isArray(snap9704.items) ? snap9704.items : [];
  const items = snapItems.length > 0 ? snapItems.map((i) => ({
    key: i.key || i.id,
    title: i.title || i.key || '-',
    status: i.status || 'NEW',
    owner: i.owner || null,
    priority: i.priority || null,
    note: i.note || '',
  })) : (() => {
    const sourceData = readJsonSafe(MOBILE_DATA_PATH, {});
    return Array.isArray(sourceData.todoRows) ? sourceData.todoRows.map((row) => ({
      title: row['할일'] ?? '-', status: row['상태'] ?? '-',
      owner: row['담당자'] ?? '-', priority: /P0/i.test(String(row['실 산출'] ?? '')) ? 'P0' : null,
      note: row['실 산출'] ?? '',
    })) : [];
  })();
  const ledgerEvents = readJsonlSafe(LEDGER_EVENTS_PATH)
    .filter((event) => {
      const key = String(event.itemKey ?? '').toUpperCase();
      const payloadText = JSON.stringify(event.payload ?? {}).toUpperCase();
      return key.includes('9704') || payloadText.includes('9704') || String(event.actor ?? '').toLowerCase() === 'design-3';
    })
    .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())
    .slice(0, 12)
    .map((event) => ({
      title: event.payload?.title || event.itemKey || '-',
      status: event.payload?.status || event.eventType || '-',
      owner: event.actor || '-',
      priority: null,
      note: summaryFromText(event.payload?.note || event.payload?.nextAction || event.payload?.approvalReason || event.itemKey || event.eventType),
    }));
  const activityRows = readJsonlSafe(AGENT_ACTIVITY_PATH);
  const todayUtcMs = todayStartUtcMs();
  const nowMs = Date.now();
  const meetingRows = (await ccPool.query(
    `SELECT author, content, created_at
       FROM meeting_messages
      WHERE created_at >= NOW() - INTERVAL '1 day'
      ORDER BY created_at DESC
      LIMIT 400`
  )).rows;
  const merged = [];
  for (const row of activityRows) {
    const ts = row.ts || row.created_at;
    if (!ts || new Date(ts).getTime() < todayUtcMs) continue;
    const agentId = String(row.agent_id || '').trim();
    if (!agentId) continue;
    const summary = summaryFromText(row.summary_natural || `${row.action} — ${row.result || row.detail || ''}`);
    merged.push({
      agentId,
      ts,
      source: 'activity',
      summary,
      action: String(row.action || ''),
      commitHashes: extractCommitHashes(`${row.result || ''} ${row.detail || ''} ${summary}`),
    });
  }
  for (const event of readJsonlSafe(LEDGER_EVENTS_PATH)) {
    const ts = event.ts;
    if (!ts || new Date(ts).getTime() < todayUtcMs) continue;
    const agentId = String(event.actor || '').trim();
    if (!agentId || agentId === 'system' || agentId === 'external-ledger-watcher') continue;
    const statusText = String(event.payload?.status || event.payload?.decision || event.eventType || '');
    const isCompleted = event.eventType === 'item.completed' || /done|completed|closed|approve/i.test(statusText);
    merged.push({
      agentId,
      ts,
      source: 'ledger',
      summary: summaryFromText(event.payload?.title || event.payload?.note || event.itemKey || event.eventType),
      action: String(event.eventType || ''),
      isCompleted,
      completedTitle: isCompleted ? summaryFromText(event.payload?.title || event.itemKey || '완료 일감') : null,
    });
  }
  for (const row of meetingRows) {
    const agentId = String(row.author || '').trim();
    if (!agentId) continue;
    merged.push({
      agentId,
      ts: row.created_at,
      source: 'meeting',
      summary: summaryFromText(row.content),
      action: 'meeting:message',
    });
  }
  const byAgent = new Map();
  const activityPointsByAgent = new Map();
  for (const entry of merged.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())) {
    if (!byAgent.has(entry.agentId)) {
      byAgent.set(entry.agentId, {
        id: entry.agentId,
        persona: PERSONA_MAP[entry.agentId] || '에이전트',
        outputs: 0,
        meetingCount: 0,
        ptyCount: 0,
        commitCount: 0,
        lastActiveAt: entry.ts,
        activities: [],
        completedTasks: [],
        seenCommits: new Set(),
      });
    }
    const tsMs = new Date(entry.ts).getTime();
    if (Number.isFinite(tsMs) && tsMs >= todayUtcMs) {
      if (!activityPointsByAgent.has(entry.agentId)) activityPointsByAgent.set(entry.agentId, []);
      activityPointsByAgent.get(entry.agentId).push(tsMs);
    }
    const bucket = byAgent.get(entry.agentId);
    if (entry.source === 'meeting') {
      bucket.meetingCount += 1;
    }
    if (entry.source === 'activity' && !/^meeting:message$/i.test(entry.action) && !/^message:instruct-reply$/i.test(entry.action) && !/^instruct$/i.test(entry.action)) {
      bucket.ptyCount += 1;
    }
    if (entry.source === 'ledger' && entry.isCompleted) {
      bucket.outputs += 1;
      if (bucket.completedTasks.length < 3 && entry.completedTitle) bucket.completedTasks.push(entry.completedTitle);
    }
    if (entry.source === 'activity' && Array.isArray(entry.commitHashes) && entry.commitHashes.length) {
      for (const hash of entry.commitHashes) {
        if (bucket.seenCommits.has(hash)) continue;
        bucket.seenCommits.add(hash);
        bucket.commitCount += 1;
        bucket.outputs += 1;
      }
    }
    if (bucket.activities.length < 3) bucket.activities.push(entry.summary);
  }
  const agents = [...byAgent.values()]
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 12)
    .map((agent) => ({
      id: agent.id,
      persona: agent.persona,
      outputsToday: agent.outputs,
      completedTaskCount: agent.completedTasks.length,
      commitCount: agent.commitCount,
      meetingCount: agent.meetingCount,
      ptyCount: agent.ptyCount,
      lastActiveAt: kstString(agent.lastActiveAt),
      recentActivities: agent.activities,
      completedTasks: agent.completedTasks,
    }));
  const agentStatuses = (await fetchAgentStatuses()).map((agent) => {
    const activity = byAgent.get(agent.id);
    const activityPoints = activityPointsByAgent.get(agent.id) || [];
    const lastActiveMs = agent.lastActiveAt && agent.lastActiveAt !== '-' ? new Date(agent.lastActiveAt.replace(' KST', '+09:00')).getTime() : NaN;
    if (Number.isFinite(lastActiveMs) && lastActiveMs >= todayUtcMs) activityPoints.push(lastActiveMs);
    const ranges = mergeActiveRanges(activityPoints.sort((a, b) => a - b), nowMs);
    let workingSeconds = ranges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0) / 1000;
    const elapsedTodaySeconds = Math.max(0, (nowMs - todayUtcMs) / 1000);
    if (agent.state === 'working' && Number.isFinite(lastActiveMs) && lastActiveMs >= todayUtcMs) {
      const extension = Math.max(0, Math.min(nowMs - lastActiveMs, 15 * 60 * 1000)) / 1000;
      workingSeconds = Math.max(workingSeconds, extension);
    }
    const idleSeconds = Math.max(0, elapsedTodaySeconds - workingSeconds);
    const outputCount = (activity?.commitCount || 0) + (activity?.completedTasks?.length || 0);
    const efficiencyScore = workingSeconds > 0 ? Number((outputCount / (workingSeconds / 3600)).toFixed(2)) : 0;
    return {
      ...agent,
      workingSeconds: Math.round(workingSeconds),
      idleSeconds: Math.round(idleSeconds),
      workingLabel: formatDurationMinutes(workingSeconds),
      idleLabel: formatDurationMinutes(idleSeconds),
      outputCount,
      efficiencyScore,
    };
  });
  return {
    snapshotTime: kstString(new Date().toISOString()),
    items,
    workers: agentStatuses,
    agentStatuses,
    activityUpdatedAt: kstString(new Date().toISOString()),
    agentActivities: agents,
    ledgerEvents,
  };
}

// GET / → 스마트에디터 2.0으로 redirect (Lucas님 지시: 9082는 에디터 전용)
app.get('/', (req, res) => res.redirect('/editor'));
// 외부 공개 모바일 업무 현황 페이지
app.get('/editor', (_req, res) => {
  res.type('html').send(buildMobileEditorHtml());
});
// 레거시 편집기 보존
app.get('/editor/legacy', (req, res) => res.render('editor-v2'));
app.get('/api/mobile-ops-data', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const payload = await buildMobileOpsPayload();
    res.json(payload);
  } catch (e) {
    console.error('[mobile-ops-data]', e?.message ?? e);
    res.status(500).json({ ok: false, error: 'mobile-ops-data-failed' });
  }
});
app.get('/api/mobile-ops-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);
  mobileOpsSseClients.add(res);
  ensureAgentUpstreamWs();
  try {
    const payload = await buildMobileOpsPayload();
    res.write(`event: snapshot\ndata: ${JSON.stringify({ reason: 'initial', payload })}\n\n`);
  } catch {
    res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: 'initial-payload-failed' })}\n\n`);
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    mobileOpsSseClients.delete(res);
    if (!mobileOpsSseClients.size && agentUpstreamWs) {
      try { agentUpstreamWs.close(); } catch {}
      agentUpstreamWs = null;
    }
  });
});

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
