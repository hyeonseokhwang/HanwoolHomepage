/**
 * 한울영성개발원 — 네이버페이 결제 클라이언트
 * PortOne(아임포트) SDK 기반
 * 작성: 하루(dev-3) | 2026-04-12
 *
 * 사용법:
 *   <script src="https://cdn.iamport.kr/js/iamport.payment-1.2.0.js"></script>
 *   <script src="/public/js/payment.js"></script>
 *   <script>
 *     HanulPay.init('imp00000000'); // Lucas님 가맹점 UID
 *   </script>
 */

const HanulPay = (() => {
  let _impUid = null;

  /** PortOne SDK 초기화 */
  function init(impUid) {
    _impUid = impUid;
    if (typeof IMP === 'undefined') {
      console.error('[HanulPay] PortOne SDK(IMP)가 로드되지 않았습니다.');
      return;
    }
    IMP.init(impUid);
    console.log('[HanulPay] PortOne 초기화 완료:', impUid);
  }

  /**
   * 네이버페이 결제 요청
   * @param {object} options
   * @param {string} options.programId   - 프로그램 ID (예: 'siann-10')
   * @param {string} options.programName - 프로그램명 (예: '한울사상 10강 수련')
   * @param {number} options.amount      - 결제 금액 (원)
   * @param {string} options.buyerName   - 신청자 이름
   * @param {string} options.buyerTel    - 연락처
   * @param {string} [options.buyerEmail] - 이메일 (선택)
   * @param {function} [options.onSuccess] - 결제 완료 콜백
   * @param {function} [options.onFail]    - 결제 실패 콜백
   */
  async function requestPay(options) {
    const { programId, programName, amount, buyerName, buyerTel, buyerEmail, onSuccess, onFail } = options;

    if (!_impUid) {
      alert('결제 서비스가 초기화되지 않았습니다. 페이지를 새로고침 해주세요.');
      return;
    }
    if (typeof IMP === 'undefined') {
      alert('결제 모듈 로드에 실패했습니다. 인터넷 연결을 확인해주세요.');
      return;
    }

    try {
      // 1. 서버에 결제 준비 요청 → merchantUid 발급
      const prepResp = await fetch('/api/payment/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId, programName, amount, buyerName, buyerTel, buyerEmail }),
      });
      const prepData = await prepResp.json();
      if (!prepData.ok) {
        alert('결제 준비 실패: ' + (prepData.error || '알 수 없는 오류'));
        if (onFail) onFail(prepData.error);
        return;
      }

      const merchantUid = prepData.merchantUid;

      // 2. PortOne 결제창 호출 (네이버페이)
      IMP.request_pay(
        {
          pg: 'naverpay',
          pay_method: 'naverpay',
          merchant_uid: merchantUid,
          name: programName,
          amount: amount,
          buyer_name: buyerName,
          buyer_tel: buyerTel,
          buyer_email: buyerEmail || '',
        },
        async (rsp) => {
          if (rsp.success) {
            // 3. 서버에서 결제 검증
            const verifyResp = await fetch('/api/payment/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ imp_uid: rsp.imp_uid, merchant_uid: rsp.merchant_uid }),
            });
            const verifyData = await verifyResp.json();

            if (verifyData.ok) {
              if (onSuccess) onSuccess({ merchantUid: rsp.merchant_uid, impUid: rsp.imp_uid });
              else location.href = '/payment/success?uid=' + rsp.merchant_uid;
            } else {
              const msg = '결제 검증 실패: ' + (verifyData.error || '금액 불일치');
              alert(msg);
              if (onFail) onFail(msg);
            }
          } else {
            const msg = rsp.error_msg || '결제가 취소되었습니다.';
            if (onFail) onFail(msg);
            else alert(msg);
          }
        }
      );
    } catch (e) {
      console.error('[HanulPay]', e);
      alert('결제 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      if (onFail) onFail(e.message);
    }
  }

  return { init, requestPay };
})();

// 전역 노출
window.HanulPay = HanulPay;
