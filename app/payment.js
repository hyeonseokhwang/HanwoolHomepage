/**
 * 네이버페이 결제 라우트 (PortOne/아임포트 연동)
 * 작성: 하루(dev-3) | 2026-04-12
 *
 * 환경변수 필요:
 *   PORTONE_IMP_KEY     — PortOne(아임포트) API 키
 *   PORTONE_IMP_SECRET  — PortOne API 시크릿
 *   PORTONE_IMP_UID     — 가맹점 식별코드 (imp00000000)
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';

export function createPaymentRouter(pool) {
  const router = express.Router();

  // ── 토큰 발급 (PortOne API) ─────────────────────────────────
  async function getPortOneToken() {
    const resp = await fetch('https://api.iamport.kr/users/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imp_key: process.env.PORTONE_IMP_KEY,
        imp_secret: process.env.PORTONE_IMP_SECRET,
      }),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error('PortOne 토큰 발급 실패: ' + data.message);
    return data.response.access_token;
  }

  // ── payments 테이블 보장 ────────────────────────────────────
  async function ensurePaymentsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id            SERIAL PRIMARY KEY,
        merchant_uid  VARCHAR(64) UNIQUE NOT NULL,
        imp_uid       VARCHAR(64),
        program_id    VARCHAR(64) NOT NULL,
        program_name  VARCHAR(256) NOT NULL,
        amount        INTEGER NOT NULL,
        buyer_name    VARCHAR(64) NOT NULL,
        buyer_tel     VARCHAR(20),
        buyer_email   VARCHAR(128),
        status        VARCHAR(16) DEFAULT 'pending',
        pay_method    VARCHAR(32),
        paid_at       TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // 인덱스 (이미 존재하면 무시)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_merchant_uid ON payments(merchant_uid)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`);
  }

  // 서버 시작 시 테이블 생성 (비동기, 에러 무시)
  ensurePaymentsTable().catch(e => console.error('[payment] table init error:', e.message));

  // ────────────────────────────────────────────────────────────
  // POST /api/payment/prepare
  // 결제 준비: DB에 pending 레코드 생성 → merchantUid 반환
  // ────────────────────────────────────────────────────────────
  router.post('/prepare', async (req, res) => {
    try {
      const { programId, programName, amount, buyerName, buyerTel, buyerEmail } = req.body;

      if (!programId || !programName || !amount || !buyerName) {
        return res.status(400).json({ ok: false, error: '필수 항목 누락 (programId, programName, amount, buyerName)' });
      }
      if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ ok: false, error: '유효하지 않은 금액' });
      }

      const merchantUid = `hanul_${Date.now()}_${uuidv4().slice(0, 8)}`;

      await pool.query(
        `INSERT INTO payments
           (merchant_uid, program_id, program_name, amount, buyer_name, buyer_tel, buyer_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [merchantUid, programId, programName, amount, buyerName, buyerTel || '', buyerEmail || '']
      );

      console.log(`[payment] prepare OK — uid=${merchantUid} program=${programName} amount=${amount}`);
      res.json({ ok: true, merchantUid, amount });
    } catch (e) {
      console.error('[payment/prepare]', e.message);
      res.status(500).json({ ok: false, error: '결제 준비 중 오류 발생' });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/payment/verify
  // 결제 검증: PortOne API로 imp_uid 조회 → DB 금액 대조 → 완료 처리
  // ────────────────────────────────────────────────────────────
  router.post('/verify', async (req, res) => {
    try {
      const { imp_uid, merchant_uid } = req.body;
      if (!imp_uid || !merchant_uid) {
        return res.status(400).json({ ok: false, error: 'imp_uid, merchant_uid 필수' });
      }

      // 1. DB에서 기대 금액 조회
      const { rows } = await pool.query(
        'SELECT amount, status FROM payments WHERE merchant_uid = $1',
        [merchant_uid]
      );
      if (!rows.length) {
        return res.status(404).json({ ok: false, error: '주문 정보를 찾을 수 없습니다' });
      }
      if (rows[0].status === 'paid') {
        return res.json({ ok: true, paid: true, message: '이미 완료된 결제입니다' });
      }

      // 2. PortOne 토큰 발급
      const token = await getPortOneToken();

      // 3. PortOne에서 결제 정보 조회
      const payResp = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
        headers: { Authorization: token },
      });
      const payData = await payResp.json();
      if (payData.code !== 0) {
        return res.status(502).json({ ok: false, error: 'PortOne 결제 조회 실패' });
      }

      const payment = payData.response;

      // 4. 금액 대조 (위변조 방지 — 핵심 보안)
      if (payment.amount !== rows[0].amount) {
        console.error(`[payment/verify] 금액 불일치: expected=${rows[0].amount} actual=${payment.amount}`);
        await pool.query(
          `UPDATE payments SET status='failed' WHERE merchant_uid=$1`,
          [merchant_uid]
        );
        return res.status(400).json({ ok: false, error: '결제 금액이 일치하지 않습니다' });
      }

      // 5. 결제 상태 확인
      if (payment.status !== 'paid') {
        return res.status(400).json({ ok: false, error: `결제 미완료 (status: ${payment.status})` });
      }

      // 6. DB 업데이트
      await pool.query(
        `UPDATE payments
         SET status='paid', imp_uid=$1, pay_method=$2, paid_at=NOW()
         WHERE merchant_uid=$3`,
        [imp_uid, payment.pay_method || 'naverpay', merchant_uid]
      );

      console.log(`[payment] verify OK — uid=${merchant_uid} imp=${imp_uid} amount=${payment.amount}`);
      res.json({ ok: true, paid: true });
    } catch (e) {
      console.error('[payment/verify]', e.message);
      res.status(500).json({ ok: false, error: '결제 검증 중 오류 발생' });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/payment/cancel
  // 결제 취소 (환불) — CTO 승인 후 활성화
  // ────────────────────────────────────────────────────────────
  router.post('/cancel', async (req, res) => {
    try {
      const { merchant_uid, reason } = req.body;
      if (!merchant_uid) return res.status(400).json({ ok: false, error: 'merchant_uid 필수' });

      const { rows } = await pool.query(
        'SELECT imp_uid, amount, status FROM payments WHERE merchant_uid=$1',
        [merchant_uid]
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: '주문 없음' });
      if (rows[0].status !== 'paid') return res.status(400).json({ ok: false, error: '취소 불가 상태' });

      const token = await getPortOneToken();
      const cancelResp = await fetch('https://api.iamport.kr/payments/cancel', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imp_uid: rows[0].imp_uid,
          amount: rows[0].amount,
          reason: reason || '고객 요청 취소',
        }),
      });
      const cancelData = await cancelResp.json();
      if (cancelData.code !== 0) {
        return res.status(502).json({ ok: false, error: '취소 실패: ' + cancelData.message });
      }

      await pool.query(
        `UPDATE payments SET status='cancelled' WHERE merchant_uid=$1`,
        [merchant_uid]
      );

      res.json({ ok: true, cancelled: true });
    } catch (e) {
      console.error('[payment/cancel]', e.message);
      res.status(500).json({ ok: false, error: '취소 처리 중 오류 발생' });
    }
  });

  // ────────────────────────────────────────────────────────────
  // GET /api/payment/status/:merchantUid
  // 결제 상태 조회
  // ────────────────────────────────────────────────────────────
  router.get('/status/:merchantUid', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT merchant_uid, program_name, amount, status, pay_method, paid_at FROM payments WHERE merchant_uid=$1',
        [req.params.merchantUid]
      );
      if (!rows.length) return res.status(404).json({ error: '주문 없음' });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
