/**
 * 한울영성개발원 공통 컴포넌트
 * - 챗봇 인라인 패널 (/api/chat SSE 직접 연동)
 * - 아카이브 모달 (/api/boards, /api/posts, /api/stats 연동)
 * - 챗봇+아카이브 전체화면 토글
 * - 네이버 로그인 버튼 + 로그인/회원가입 모달 (목업)
 * 2026-04-17 | 이든(Eden) — UX 고도화
 */
(function() {
  const API = 'http://211.104.37.65:8081';

  /* ── CSS 주입 ─────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    /* 공통 변수 */
    :root {
      --hc-charcoal:#1C1C1C;--hc-gold:#C9A96E;--hc-gold-deep:#A8883F;
      --hc-cream:#FAF8F4;--hc-cream-dark:#F0EDE7;--hc-forest:#4A7C59;
    }

    /* ── 챗봇A 플로팅 (법문용) ── */
    .hc-chatbot-float {
      position:fixed;bottom:28px;right:28px;z-index:9000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;
    }
    .hc-chatbot-label {
      background:var(--hc-charcoal);color:#fff;font-size:12px;padding:7px 14px;
      border-radius:4px;border:1px solid rgba(201,169,110,.25);white-space:nowrap;
      opacity:0;transform:translateX(8px);transition:.2s;pointer-events:none;
    }
    .hc-chatbot-float:hover .hc-chatbot-label { opacity:1;transform:translateX(0); }
    .hc-chatbot-btn {
      width:58px;height:58px;border-radius:50%;background:var(--hc-charcoal);
      border:1.5px solid var(--hc-gold);color:var(--hc-gold);font-size:22px;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 28px rgba(0,0,0,.45);transition:transform .2s,box-shadow .2s;
    }
    .hc-chatbot-btn:hover { transform:scale(1.08);box-shadow:0 8px 36px rgba(201,169,110,.25); }

    /* ── 챗봇B 플로팅 (안내용) ── */
    .hc-chatbot-b-float {
      position:fixed;bottom:100px;right:96px;z-index:9000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;
    }
    .hc-chatbot-b-label {
      background:var(--hc-forest);color:#fff;font-size:12px;padding:7px 14px;
      border-radius:4px;border:1px solid rgba(74,124,89,.4);white-space:nowrap;
      opacity:0;transform:translateX(8px);transition:.2s;pointer-events:none;
    }
    .hc-chatbot-b-float:hover .hc-chatbot-b-label { opacity:1;transform:translateX(0); }
    .hc-chatbot-b-btn {
      width:52px;height:52px;border-radius:50%;background:var(--hc-forest);
      border:1.5px solid rgba(74,124,89,.8);color:#fff;font-size:20px;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 28px rgba(0,0,0,.45);transition:transform .2s,box-shadow .2s;
    }
    .hc-chatbot-b-btn:hover { transform:scale(1.08);box-shadow:0 8px 36px rgba(74,124,89,.3); }

    /* ── 아카이브 버튼 ── */
    .hc-archive-float {
      position:fixed;bottom:100px;right:28px;z-index:9000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;
    }
    .hc-archive-label {
      background:var(--hc-charcoal);color:#fff;font-size:12px;padding:7px 14px;
      border-radius:4px;border:1px solid rgba(201,169,110,.25);white-space:nowrap;
      opacity:0;transform:translateX(8px);transition:.2s;pointer-events:none;
    }
    .hc-archive-float:hover .hc-archive-label { opacity:1;transform:translateX(0); }
    .hc-archive-btn {
      width:58px;height:58px;border-radius:50%;background:var(--hc-charcoal);
      border:1.5px solid var(--hc-gold);color:var(--hc-gold);font-size:20px;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 28px rgba(0,0,0,.45);transition:transform .2s,box-shadow .2s;
    }
    .hc-archive-btn:hover { transform:scale(1.08);box-shadow:0 8px 36px rgba(201,169,110,.25); }

    /* ── 공통 모달 헤더 버튼 ── */
    .hc-header-btn {
      background:none;border:none;color:rgba(255,255,255,.6);font-size:18px;cursor:pointer;
      width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:4px;
      transition:.2s;flex-shrink:0;
    }
    .hc-header-btn:hover { background:rgba(255,255,255,.1);color:#fff; }

    /* ── 챗봇 모달 ── */
    .hc-chat-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9100;
      display:none;align-items:flex-end;justify-content:center;
    }
    .hc-chat-overlay.open { display:flex;animation:hcFadeIn .25s; }
    @keyframes hcFadeIn { from{opacity:0} to{opacity:1} }
    .hc-chat-panel {
      background:var(--hc-cream);width:100%;max-width:640px;height:75vh;
      border-radius:12px 12px 0 0;overflow:hidden;display:flex;flex-direction:column;
      box-shadow:0 -12px 48px rgba(0,0,0,.35);transition:max-width .2s,height .2s,border-radius .2s;
    }
    .hc-chat-overlay.fullscreen .hc-chat-panel {
      max-width:100%;height:100vh;border-radius:0;
    }
    .hc-chat-header {
      background:var(--hc-charcoal);padding:16px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0;
    }
    .hc-chat-header-title { color:#fff;font-size:16px;font-weight:700;flex:1; }
    .hc-chat-messages {
      flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px;
      background:#fff;
    }
    .hc-chat-msg { display:flex;flex-direction:column;gap:4px;max-width:85%; }
    .hc-chat-msg.user { align-self:flex-end;align-items:flex-end; }
    .hc-chat-msg.bot { align-self:flex-start;align-items:flex-start; }
    .hc-chat-bubble {
      padding:11px 15px;border-radius:12px;font-size:14px;line-height:1.7;
      white-space:pre-wrap;word-break:break-word;
    }
    .hc-chat-msg.user .hc-chat-bubble { background:var(--hc-charcoal);color:#fff;border-radius:12px 12px 2px 12px; }
    .hc-chat-msg.bot .hc-chat-bubble { background:var(--hc-cream-dark);color:var(--hc-charcoal);border-radius:12px 12px 12px 2px; }
    .hc-chat-msg.bot .hc-chat-bubble.streaming { border-right:2px solid var(--hc-gold);animation:hcBlink .7s infinite; }
    .hc-chat-overlay.chat-b .hc-chat-header { background:var(--hc-forest); }
    .hc-chat-overlay.chat-b .hc-chat-msg.bot .hc-chat-bubble.streaming { border-right-color:var(--hc-forest); }
    @keyframes hcBlink { 50% { border-color:transparent; } }
    .hc-chat-msg-meta { font-size:11px;color:#bbb; }
    .hc-chat-input-area {
      padding:14px 16px;background:var(--hc-cream);border-top:1px solid var(--hc-cream-dark);
      display:flex;gap:10px;flex-shrink:0;
    }
    .hc-chat-input {
      flex:1;border:1px solid #ddd;border-radius:6px;padding:10px 14px;font-size:14px;
      outline:none;font-family:inherit;resize:none;max-height:100px;line-height:1.5;
    }
    .hc-chat-input:focus { border-color:var(--hc-gold); }
    .hc-chat-send {
      background:var(--hc-charcoal);color:var(--hc-gold);border:none;
      padding:10px 18px;border-radius:6px;font-size:14px;font-weight:700;
      cursor:pointer;font-family:inherit;transition:.2s;white-space:nowrap;
    }
    .hc-chat-send:hover { background:var(--hc-gold-deep);color:#fff; }
    .hc-chat-send:disabled { opacity:.4;cursor:not-allowed; }
    .hc-chat-welcome {
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:8px;padding:32px 20px;color:#aaa;font-size:14px;text-align:center;
    }
    .hc-chat-welcome-icon { font-size:36px;margin-bottom:4px; }

    /* ── 아카이브 모달 ── */
    .hc-archive-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9100;
      display:none;align-items:flex-end;justify-content:center;
    }
    .hc-archive-overlay.open { display:flex;animation:hcFadeIn .25s; }
    .hc-archive-panel {
      background:var(--hc-cream);width:100%;max-width:960px;height:85vh;
      border-radius:12px 12px 0 0;overflow:hidden;display:flex;flex-direction:column;
      box-shadow:0 -12px 48px rgba(0,0,0,.35);transition:max-width .2s,height .2s,border-radius .2s;
    }
    .hc-archive-overlay.fullscreen .hc-archive-panel {
      max-width:100%;height:100vh;border-radius:0;
    }
    .hc-archive-header {
      background:var(--hc-charcoal);padding:16px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0;
    }
    .hc-archive-header-info { flex:1; }
    .hc-archive-header-title { color:#fff;font-size:16px;font-weight:700; }
    .hc-archive-header-stats { font-size:12px;color:rgba(255,255,255,.5);margin-top:2px; }
    .hc-archive-search {
      padding:14px 20px;background:#fff;border-bottom:1px solid var(--hc-cream-dark);flex-shrink:0;display:flex;gap:10px;
    }
    .hc-archive-search input {
      flex:1;border:1px solid #ddd;border-radius:4px;padding:10px 14px;font-size:14px;outline:none;
      font-family:inherit;
    }
    .hc-archive-search input:focus { border-color:var(--hc-gold); }
    .hc-archive-search-btn {
      background:var(--hc-charcoal);color:#fff;border:none;padding:10px 20px;border-radius:4px;
      font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:.2s;white-space:nowrap;
    }
    .hc-archive-search-btn:hover { background:var(--hc-gold-deep); }
    .hc-archive-body { display:flex;flex:1;overflow:hidden; }
    .hc-archive-boards {
      width:180px;border-right:1px solid var(--hc-cream-dark);overflow-y:auto;flex-shrink:0;background:#fff;
    }
    .hc-archive-boards-title {
      font-size:11px;font-weight:700;letter-spacing:.1em;color:#999;padding:14px 16px 8px;text-transform:uppercase;
    }
    .hc-board-item {
      padding:10px 16px;font-size:13px;cursor:pointer;border-left:3px solid transparent;
      transition:.15s;display:flex;justify-content:space-between;align-items:center;
    }
    .hc-board-item:hover { background:var(--hc-cream);border-left-color:var(--hc-gold); }
    .hc-board-item.active { background:var(--hc-cream);border-left-color:var(--hc-gold);font-weight:700;color:var(--hc-charcoal); }
    .hc-board-count { font-size:11px;color:#bbb; }
    .hc-archive-posts { flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px; }
    .hc-post-card {
      background:#fff;border:1px solid var(--hc-cream-dark);border-radius:4px;
      padding:16px 20px;cursor:pointer;transition:.15s;
    }
    .hc-post-card:hover { border-color:var(--hc-gold);box-shadow:0 4px 12px rgba(201,169,110,.1); }
    .hc-post-board { font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--hc-gold);margin-bottom:6px; }
    .hc-post-title { font-size:15px;font-weight:600;margin-bottom:4px;color:var(--hc-charcoal);line-height:1.4; }
    .hc-post-preview { font-size:13px;color:#888;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
    .hc-post-meta { font-size:12px;color:#bbb;margin-top:8px;display:flex;gap:12px; }
    .hc-posts-loading { text-align:center;padding:40px;color:#bbb;font-size:14px; }
    .hc-archive-pagination {
      padding:14px 20px;border-top:1px solid var(--hc-cream-dark);background:#fff;
      display:flex;justify-content:center;align-items:center;gap:8px;flex-shrink:0;
    }
    .hc-page-btn {
      background:none;border:1px solid #ddd;padding:6px 12px;font-size:13px;cursor:pointer;
      border-radius:2px;font-family:inherit;transition:.15s;
    }
    .hc-page-btn:hover { border-color:var(--hc-gold);color:var(--hc-gold-deep); }
    .hc-page-btn.active { background:var(--hc-charcoal);color:#fff;border-color:var(--hc-charcoal); }

    /* ── 포스트 상세 모달 ── */
    .hc-post-detail-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9200;
      display:none;align-items:center;justify-content:center;padding:20px;
    }
    .hc-post-detail-overlay.open { display:flex;animation:hcFadeIn .2s; }
    .hc-post-detail-panel {
      background:#fff;width:100%;max-width:720px;max-height:85vh;border-radius:8px;
      overflow:hidden;display:flex;flex-direction:column;
      transition:max-width .2s,max-height .2s,border-radius .2s;
    }
    .hc-post-detail-overlay.fullscreen .hc-post-detail-panel {
      max-width:100%;max-height:100vh;border-radius:0;
    }
    .hc-post-detail-header {
      background:var(--hc-charcoal);padding:16px 20px;display:flex;align-items:flex-start;gap:12px;flex-shrink:0;
    }
    .hc-post-detail-title-wrap { flex:1; }
    .hc-post-detail-board { font-size:11px;color:var(--hc-gold);font-weight:700;letter-spacing:.1em;margin-bottom:6px; }
    .hc-post-detail-title { font-size:18px;font-weight:700;color:#fff;line-height:1.3; }
    .hc-post-detail-meta { font-size:12px;color:rgba(255,255,255,.45);margin-top:6px; }
    .hc-post-detail-body { padding:24px;overflow-y:auto;flex:1;font-size:15px;line-height:1.8;color:var(--hc-charcoal); }
    .hc-post-detail-loading { text-align:center;padding:40px;color:#bbb; }

    /* ── 네이버 로그인 버튼 (GNB 통합) ── */
    .hc-nav-login-btn {
      background:#03C75A;color:#fff;border:none;padding:6px 14px;border-radius:3px;
      font-size:0.84rem;font-weight:700;cursor:pointer;font-family:inherit;
      display:inline-flex;align-items:center;gap:5px;transition:.15s;white-space:nowrap;
      vertical-align:middle;
    }
    .hc-nav-login-btn:hover { background:#02b350;color:#fff; }
    .hc-nav-login-btn svg { width:13px;height:13px;fill:#fff;flex-shrink:0; }

    /* ── 공통 인증 모달 ── */
    .hc-auth-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9300;
      display:none;align-items:center;justify-content:center;padding:20px;
    }
    .hc-auth-overlay.open { display:flex;animation:hcFadeIn .2s; }
    .hc-auth-panel {
      background:#fff;width:100%;max-width:420px;border-radius:10px;
      overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);
    }
    .hc-auth-header {
      background:var(--hc-charcoal);padding:20px 24px;display:flex;align-items:center;
    }
    .hc-auth-header-title { color:#fff;font-size:17px;font-weight:700;flex:1; }
    .hc-auth-body { padding:28px 24px;display:flex;flex-direction:column;gap:14px; }
    .hc-auth-naver-btn {
      width:100%;background:#03C75A;color:#fff;border:none;padding:13px;border-radius:6px;
      font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;
      display:flex;align-items:center;justify-content:center;gap:8px;transition:.15s;
    }
    .hc-auth-naver-btn:hover { background:#02b350; }
    .hc-auth-naver-btn svg { width:18px;height:18px;fill:#fff; }
    .hc-auth-divider {
      display:flex;align-items:center;gap:12px;color:#ccc;font-size:12px;
    }
    .hc-auth-divider::before,.hc-auth-divider::after {
      content:'';flex:1;height:1px;background:#eee;
    }
    .hc-auth-field { display:flex;flex-direction:column;gap:6px; }
    .hc-auth-label { font-size:13px;color:#666;font-weight:600; }
    .hc-auth-input {
      border:1px solid #ddd;border-radius:6px;padding:11px 14px;font-size:14px;
      outline:none;font-family:inherit;transition:.15s;
    }
    .hc-auth-input:focus { border-color:#03C75A;box-shadow:0 0 0 3px rgba(3,199,90,.1); }
    .hc-auth-submit {
      width:100%;background:var(--hc-charcoal);color:#fff;border:none;padding:13px;
      border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;
      transition:.2s;margin-top:4px;
    }
    .hc-auth-submit:hover { background:var(--hc-gold-deep); }
    .hc-auth-switch {
      text-align:center;font-size:13px;color:#999;padding-top:4px;
    }
    .hc-auth-switch a { color:var(--hc-gold-deep);cursor:pointer;text-decoration:none;font-weight:600; }
    .hc-auth-switch a:hover { text-decoration:underline; }
  `;
  document.head.appendChild(style);

  /* ── 상태 ──────────────────────────────────────────────────── */
  let currentBoard = null;
  let currentPage = 1;
  let currentSearch = '';
  let statsData = null;
  let chatStreamingA = false;
  let chatStreamingB = false;

  /* ── DOM 생성 ───────────────────────────────────────────────── */
  document.body.insertAdjacentHTML('beforeend', `
    <!-- 챗봇A 플로팅 (법문/경전) -->
    <div class="hc-chatbot-float">
      <span class="hc-chatbot-label">📖 법문·경전 상담</span>
      <button class="hc-chatbot-btn" id="hcChatBtn" title="법문·경전 챗봇">📖</button>
    </div>

    <!-- 챗봇B 플로팅 (안내용) -->
    <div class="hc-chatbot-b-float">
      <span class="hc-chatbot-b-label">💬 한울영성개발원 안내</span>
      <button class="hc-chatbot-b-btn" id="hcChatBBtn" title="안내 챗봇">💬</button>
    </div>

    <!-- 아카이브 플로팅 -->
    <div class="hc-archive-float">
      <span class="hc-archive-label">법문 아카이브 · 11,702건</span>
      <button class="hc-archive-btn" id="hcArchiveBtn" title="법문 아카이브">📚</button>
    </div>

    <!-- 챗봇A 모달 (법문·경전) -->
    <div class="hc-chat-overlay" id="hcChatOverlay">
      <div class="hc-chat-panel">
        <div class="hc-chat-header">
          <div class="hc-chat-header-title">📖 법문·경전 챗봇</div>
          <button class="hc-header-btn" id="hcChatFullscreen" title="전체화면">⛶</button>
          <button class="hc-header-btn" id="hcChatClose" title="닫기">✕</button>
        </div>
        <div class="hc-chat-messages" id="hcChatMessages">
          <div class="hc-chat-welcome">
            <div class="hc-chat-welcome-icon">📖</div>
            <div>법문·경전에 대해 여쭤보세요</div>
            <div style="font-size:12px;color:#ccc">큰스승님 말씀 809건 + 무견스승님 법문 11,551건 · 경전 3권 RAG 기반</div>
          </div>
        </div>
        <div class="hc-chat-input-area">
          <textarea class="hc-chat-input" id="hcChatInput" rows="1" placeholder="예: 해인의 진실 3장에서 무슨 말씀을 하셨나요?"></textarea>
          <button class="hc-chat-send" id="hcChatSend">전송</button>
        </div>
      </div>
    </div>

    <!-- 챗봇B 모달 (안내용) -->
    <div class="hc-chat-overlay chat-b" id="hcChatBOverlay">
      <div class="hc-chat-panel">
        <div class="hc-chat-header">
          <div class="hc-chat-header-title">💬 한울영성개발원 안내</div>
          <button class="hc-header-btn" id="hcChatBFullscreen" title="전체화면">⛶</button>
          <button class="hc-header-btn" id="hcChatBClose" title="닫기">✕</button>
        </div>
        <div class="hc-chat-messages" id="hcChatBMessages">
          <div class="hc-chat-welcome">
            <div class="hc-chat-welcome-icon">🌿</div>
            <div>한울영성개발원에 오신 것을 환영합니다</div>
            <div style="font-size:12px;color:#ccc">프로그램 안내 · 수련 신청 · 방문 안내</div>
          </div>
        </div>
        <div class="hc-chat-input-area">
          <textarea class="hc-chat-input" id="hcChatBInput" rows="1" placeholder="예: 수련 프로그램은 어떤 것이 있나요?"></textarea>
          <button class="hc-chat-send" id="hcChatBSend">전송</button>
        </div>
      </div>
    </div>

    <!-- 아카이브 모달 -->
    <div class="hc-archive-overlay" id="hcArchiveOverlay">
      <div class="hc-archive-panel">
        <div class="hc-archive-header">
          <div class="hc-archive-header-info">
            <div class="hc-archive-header-title">📚 한울 법문 아카이브</div>
            <div class="hc-archive-header-stats" id="hcArchiveStats">로딩 중...</div>
          </div>
          <button class="hc-header-btn" id="hcArchiveFullscreen" title="전체화면">⛶</button>
          <button class="hc-header-btn" id="hcArchiveClose" title="닫기">✕</button>
        </div>
        <div class="hc-archive-search">
          <input type="text" id="hcSearchInput" placeholder="법문 검색 — 키워드 입력..." />
          <button class="hc-archive-search-btn" id="hcSearchBtn">검색</button>
        </div>
        <div class="hc-archive-body">
          <div class="hc-archive-boards">
            <div class="hc-archive-boards-title">게시판</div>
            <div id="hcBoardList"><div class="hc-posts-loading">로딩...</div></div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
            <div class="hc-archive-posts" id="hcPostList"><div class="hc-posts-loading">게시판을 선택하세요</div></div>
            <div class="hc-archive-pagination" id="hcPagination" style="display:none;"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 로그인 모달 -->
    <div class="hc-auth-overlay" id="hcLoginOverlay">
      <div class="hc-auth-panel">
        <div class="hc-auth-header">
          <div class="hc-auth-header-title">로그인</div>
          <button class="hc-header-btn" id="hcLoginClose">✕</button>
        </div>
        <div class="hc-auth-body">
          <button class="hc-auth-naver-btn" id="hcNaverLoginBtn">
            <svg viewBox="0 0 24 24"><path d="M16.273 12.845L7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>
            네이버로 로그인
          </button>
          <div class="hc-auth-divider">또는 이메일로 로그인</div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">이메일</label>
            <input class="hc-auth-input" type="email" placeholder="이메일 주소 입력" />
          </div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">비밀번호</label>
            <input class="hc-auth-input" type="password" placeholder="비밀번호 입력" />
          </div>
          <button class="hc-auth-submit">로그인</button>
          <div class="hc-auth-switch">
            계정이 없으신가요? <a id="hcGoSignup">회원가입</a>
          </div>
        </div>
      </div>
    </div>

    <!-- 회원가입 모달 -->
    <div class="hc-auth-overlay" id="hcSignupOverlay">
      <div class="hc-auth-panel">
        <div class="hc-auth-header">
          <div class="hc-auth-header-title">회원가입</div>
          <button class="hc-header-btn" id="hcSignupClose">✕</button>
        </div>
        <div class="hc-auth-body">
          <button class="hc-auth-naver-btn">
            <svg viewBox="0 0 24 24"><path d="M16.273 12.845L7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>
            네이버로 시작하기
          </button>
          <div class="hc-auth-divider">또는 이메일로 가입</div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">이름</label>
            <input class="hc-auth-input" type="text" placeholder="이름 입력" />
          </div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">이메일</label>
            <input class="hc-auth-input" type="email" placeholder="이메일 주소 입력" />
          </div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">비밀번호</label>
            <input class="hc-auth-input" type="password" placeholder="8자 이상 입력" />
          </div>
          <div class="hc-auth-field">
            <label class="hc-auth-label">비밀번호 확인</label>
            <input class="hc-auth-input" type="password" placeholder="비밀번호 재입력" />
          </div>
          <button class="hc-auth-submit">회원가입</button>
          <div class="hc-auth-switch">
            이미 계정이 있으신가요? <a id="hcGoLogin">로그인</a>
          </div>
        </div>
      </div>
    </div>

    <!-- 포스트 상세 모달 -->
    <div class="hc-post-detail-overlay" id="hcPostDetailOverlay">
      <div class="hc-post-detail-panel">
        <div class="hc-post-detail-header">
          <div class="hc-post-detail-title-wrap">
            <div class="hc-post-detail-board" id="hcDetailBoard"></div>
            <div class="hc-post-detail-title" id="hcDetailTitle"></div>
            <div class="hc-post-detail-meta" id="hcDetailMeta"></div>
          </div>
          <button class="hc-header-btn" id="hcDetailFullscreen" title="전체화면">⛶</button>
          <button class="hc-header-btn" id="hcDetailClose" title="닫기">✕</button>
        </div>
        <div class="hc-post-detail-body" id="hcDetailBody"><div class="hc-post-detail-loading">로딩 중...</div></div>
      </div>
    </div>
  `);

  /* ── GNB 네이버 로그인 버튼 삽입 ────────────────────────── */
  (function injectNavLogin() {
    // nav-links 내 li로 삽입 — GNB 메뉴와 같은 라인에 자연스럽게 통합
    const navLinks = document.querySelector('nav .nav-links, nav ul');
    if (!navLinks) return;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'hc-nav-login-btn';
    btn.id = 'hcNavLoginTrigger';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16.273 12.845L7.376 0H0v24h7.727V11.155L16.624 24H24V0h-7.727z"/></svg>로그인`;
    li.appendChild(btn);
    navLinks.appendChild(li);
    btn.addEventListener('click', () => {
      document.getElementById('hcLoginOverlay').classList.add('open');
    });
  })();

  /* ── 로그인/회원가입 모달 이벤트 ─────────────────────────── */
  document.getElementById('hcLoginClose').addEventListener('click', () => {
    document.getElementById('hcLoginOverlay').classList.remove('open');
  });
  document.getElementById('hcLoginOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
  document.getElementById('hcSignupClose').addEventListener('click', () => {
    document.getElementById('hcSignupOverlay').classList.remove('open');
  });
  document.getElementById('hcSignupOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
  document.getElementById('hcGoSignup').addEventListener('click', () => {
    document.getElementById('hcLoginOverlay').classList.remove('open');
    document.getElementById('hcSignupOverlay').classList.add('open');
  });
  document.getElementById('hcGoLogin').addEventListener('click', () => {
    document.getElementById('hcSignupOverlay').classList.remove('open');
    document.getElementById('hcLoginOverlay').classList.add('open');
  });
  document.getElementById('hcNaverLoginBtn').addEventListener('click', () => {
    alert('네이버 OAuth 연동은 서비스 런칭 시 활성화됩니다.');
  });

  /* ── 챗봇 이벤트 ─────────────────────────────────────────── */
  document.getElementById('hcChatBtn').addEventListener('click', () => {
    document.getElementById('hcChatOverlay').classList.add('open');
    document.getElementById('hcChatInput').focus();
  });
  document.getElementById('hcChatClose').addEventListener('click', () => {
    document.getElementById('hcChatOverlay').classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcChatOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcChatFullscreen').addEventListener('click', () => {
    const overlay = document.getElementById('hcChatOverlay');
    const isFs = overlay.classList.toggle('fullscreen');
    document.getElementById('hcChatFullscreen').title = isFs ? '일반화면' : '전체화면';
    document.getElementById('hcChatFullscreen').textContent = isFs ? '⊡' : '⛶';
  });

  // 입력창 자동 높이
  document.getElementById('hcChatInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
  document.getElementById('hcChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatA(); }
  });
  document.getElementById('hcChatSend').addEventListener('click', sendChatA);

  /* ── 챗봇B 이벤트 ────────────────────────────────────────── */
  document.getElementById('hcChatBBtn').addEventListener('click', () => {
    document.getElementById('hcChatBOverlay').classList.add('open');
    document.getElementById('hcChatBInput').focus();
  });
  document.getElementById('hcChatBClose').addEventListener('click', () => {
    document.getElementById('hcChatBOverlay').classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcChatBOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcChatBFullscreen').addEventListener('click', () => {
    const overlay = document.getElementById('hcChatBOverlay');
    const isFs = overlay.classList.toggle('fullscreen');
    document.getElementById('hcChatBFullscreen').title = isFs ? '일반화면' : '전체화면';
    document.getElementById('hcChatBFullscreen').textContent = isFs ? '⊡' : '⛶';
  });
  document.getElementById('hcChatBInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
  document.getElementById('hcChatBInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatB(); }
  });
  document.getElementById('hcChatBSend').addEventListener('click', sendChatB);

  /* ── ESC 전역 핸들러 (전체화면 종료) ─────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['hcChatOverlay','hcChatBOverlay','hcArchiveOverlay','hcPostDetailOverlay','hcLoginOverlay','hcSignupOverlay'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (el.classList.contains('fullscreen')) {
          el.classList.remove('fullscreen');
        } else if (el.classList.contains('open')) {
          el.classList.remove('open');
        }
      }
    });
  });

  /* ── 챗봇 공통 SSE 함수 팩토리 ───────────────────────────── */
  function makeSendChat({ endpointPath, streamingFlag, inputId, sendBtnId, messagesId, welcomeSelector, getStreaming, setStreaming }) {
    return async function() {
      if (getStreaming()) return;
      const input = document.getElementById(inputId);
      const msg = input.value.trim();
      if (!msg) return;

      input.value = '';
      input.style.height = 'auto';
      appendChatMsg('user', msg, messagesId);

      const welcome = document.querySelector(welcomeSelector);
      if (welcome) welcome.remove();

      const botBubble = appendChatMsg('bot', '', messagesId);
      botBubble.classList.add('streaming');
      document.getElementById(sendBtnId).disabled = true;
      setStreaming(true);

      try {
        const res = await fetch(API + endpointPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });

        if (!res.ok || !res.body) {
          botBubble.textContent = '죄송합니다. 현재 연결이 원활하지 않습니다.';
          botBubble.classList.remove('streaming');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content || parsed.token || parsed.text || parsed.content || '';
              fullText += token;
              botBubble.textContent = fullText;
              scrollChatBottom(messagesId);
            } catch {
              if (data && data !== '[DONE]') { fullText += data; botBubble.textContent = fullText; scrollChatBottom(messagesId); }
            }
          }
        }

        if (!fullText) botBubble.textContent = '죄송합니다. 응답을 받지 못했습니다.';
      } catch (e) {
        botBubble.textContent = '서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.';
      } finally {
        botBubble.classList.remove('streaming');
        document.getElementById(sendBtnId).disabled = false;
        setStreaming(false);
        scrollChatBottom(messagesId);
      }
    };
  }

  const sendChatA = makeSendChat({
    endpointPath: '/api/chat/dharma',
    inputId: 'hcChatInput',
    sendBtnId: 'hcChatSend',
    messagesId: 'hcChatMessages',
    welcomeSelector: '#hcChatMessages .hc-chat-welcome',
    getStreaming: () => chatStreamingA,
    setStreaming: (v) => { chatStreamingA = v; },
  });

  const sendChatB = makeSendChat({
    endpointPath: '/api/chat/guide',
    inputId: 'hcChatBInput',
    sendBtnId: 'hcChatBSend',
    messagesId: 'hcChatBMessages',
    welcomeSelector: '#hcChatBMessages .hc-chat-welcome',
    getStreaming: () => chatStreamingB,
    setStreaming: (v) => { chatStreamingB = v; },
  });

  function appendChatMsg(role, text, containerId) {
    const container = document.getElementById(containerId || 'hcChatMessages');
    const wrap = document.createElement('div');
    wrap.className = 'hc-chat-msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'hc-chat-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    scrollChatBottom(containerId);
    return bubble;
  }

  function scrollChatBottom(containerId) {
    const el = document.getElementById(containerId || 'hcChatMessages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* ── 아카이브 이벤트 ─────────────────────────────────────── */
  document.getElementById('hcArchiveBtn').addEventListener('click', () => {
    document.getElementById('hcArchiveOverlay').classList.add('open');
    if (!statsData) loadStats();
    if (!document.querySelector('.hc-board-item')) loadBoards();
  });
  document.getElementById('hcArchiveClose').addEventListener('click', () => {
    document.getElementById('hcArchiveOverlay').classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcArchiveOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcArchiveFullscreen').addEventListener('click', () => {
    const overlay = document.getElementById('hcArchiveOverlay');
    const isFs = overlay.classList.toggle('fullscreen');
    document.getElementById('hcArchiveFullscreen').title = isFs ? '일반화면' : '전체화면';
    document.getElementById('hcArchiveFullscreen').textContent = isFs ? '⊡' : '⛶';
  });

  // 검색
  document.getElementById('hcSearchBtn').addEventListener('click', doSearch);
  document.getElementById('hcSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // 상세 닫기
  document.getElementById('hcDetailClose').addEventListener('click', () => {
    document.getElementById('hcPostDetailOverlay').classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcPostDetailOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open', 'fullscreen');
  });
  document.getElementById('hcDetailFullscreen').addEventListener('click', () => {
    const overlay = document.getElementById('hcPostDetailOverlay');
    const isFs = overlay.classList.toggle('fullscreen');
    document.getElementById('hcDetailFullscreen').title = isFs ? '일반화면' : '전체화면';
    document.getElementById('hcDetailFullscreen').textContent = isFs ? '⊡' : '⛶';
  });

  /* ── API 함수 ────────────────────────────────────────────────── */
  function loadStats() {
    fetch(API + '/api/stats')
      .then(r => r.json())
      .then(d => {
        statsData = d;
        document.getElementById('hcArchiveStats').textContent =
          '총 ' + d.totalPosts.toLocaleString() + '건 · 댓글 ' + d.totalComments.toLocaleString() + '건 · 2005~2026년';
      })
      .catch(() => {
        document.getElementById('hcArchiveStats').textContent = '법문 아카이브 2005~현재';
      });
  }

  function loadBoards() {
    fetch(API + '/api/boards')
      .then(r => r.json())
      .then(boards => {
        const el = document.getElementById('hcBoardList');
        el.innerHTML = '';
        const allItem = document.createElement('div');
        allItem.className = 'hc-board-item active';
        allItem.innerHTML = '<span>전체</span>';
        allItem.addEventListener('click', () => selectBoard(null, allItem));
        el.appendChild(allItem);

        boards.forEach(b => {
          const item = document.createElement('div');
          item.className = 'hc-board-item';
          item.innerHTML = '<span>' + escHtml(b.board) + '</span><span class="hc-board-count">' + Number(b.count).toLocaleString() + '</span>';
          item.addEventListener('click', () => selectBoard(b.board, item));
          el.appendChild(item);
        });
        loadPosts(null, 1, '');
      })
      .catch(() => {
        document.getElementById('hcBoardList').innerHTML = '<div style="padding:12px 16px;font-size:13px;color:#aaa">로드 실패</div>';
      });
  }

  function selectBoard(board, itemEl) {
    currentBoard = board;
    currentPage = 1;
    currentSearch = '';
    document.getElementById('hcSearchInput').value = '';
    document.querySelectorAll('.hc-board-item').forEach(el => el.classList.remove('active'));
    itemEl.classList.add('active');
    loadPosts(board, 1, '');
  }

  function doSearch() {
    currentSearch = document.getElementById('hcSearchInput').value.trim();
    currentPage = 1;
    loadPosts(currentBoard, 1, currentSearch);
  }

  function loadPosts(board, page, search) {
    const postEl = document.getElementById('hcPostList');
    postEl.innerHTML = '<div class="hc-posts-loading">로딩 중...</div>';
    document.getElementById('hcPagination').style.display = 'none';

    let url = API + '/api/posts?page=' + page + '&limit=12';
    if (board) url += '&board=' + encodeURIComponent(board);
    if (search) url += '&search=' + encodeURIComponent(search);

    fetch(url)
      .then(r => r.json())
      .then(data => {
        postEl.innerHTML = '';
        if (!data.posts || data.posts.length === 0) {
          postEl.innerHTML = '<div class="hc-posts-loading">검색 결과가 없습니다.</div>';
          return;
        }
        data.posts.forEach(post => {
          const card = document.createElement('div');
          card.className = 'hc-post-card';
          const dateStr = post.created_at ? post.created_at.substring(0, 10) : '';
          card.innerHTML = `
            <div class="hc-post-board">${escHtml(post.board)}</div>
            <div class="hc-post-title">${escHtml(post.title)}</div>
            ${post.preview ? '<div class="hc-post-preview">' + escHtml(post.preview) + '</div>' : ''}
            <div class="hc-post-meta">
              <span>${escHtml(post.author || '')}</span>
              <span>${dateStr}</span>
              ${post.comment_count > 0 ? '<span>댓글 ' + post.comment_count + '</span>' : ''}
            </div>
          `;
          card.addEventListener('click', () => openPostDetail(post));
          postEl.appendChild(card);
        });

        if (data.total > 12) {
          renderPagination(data.total, page, board, search);
        }
      })
      .catch(() => {
        postEl.innerHTML = '<div class="hc-posts-loading">로드 실패. 서버 연결을 확인하세요.</div>';
      });
  }

  function renderPagination(total, page, board, search) {
    const totalPages = Math.ceil(total / 12);
    const pagEl = document.getElementById('hcPagination');
    pagEl.style.display = 'flex';
    pagEl.innerHTML = '';

    const start = Math.max(1, page - 3);
    const end = Math.min(totalPages, page + 3);

    if (page > 1) {
      const btn = document.createElement('button');
      btn.className = 'hc-page-btn';
      btn.textContent = '‹';
      btn.addEventListener('click', () => { currentPage = page - 1; loadPosts(board, page - 1, search); });
      pagEl.appendChild(btn);
    }

    for (let i = start; i <= end; i++) {
      const btn = document.createElement('button');
      btn.className = 'hc-page-btn' + (i === page ? ' active' : '');
      btn.textContent = i;
      const p = i;
      btn.addEventListener('click', () => { currentPage = p; loadPosts(board, p, search); });
      pagEl.appendChild(btn);
    }

    if (page < totalPages) {
      const btn = document.createElement('button');
      btn.className = 'hc-page-btn';
      btn.textContent = '›';
      btn.addEventListener('click', () => { currentPage = page + 1; loadPosts(board, page + 1, search); });
      pagEl.appendChild(btn);
    }

    const info = document.createElement('span');
    info.style.cssText = 'font-size:12px;color:#aaa;margin-left:8px';
    info.textContent = total.toLocaleString() + '건 / ' + totalPages + '페이지';
    pagEl.appendChild(info);
  }

  function openPostDetail(post) {
    document.getElementById('hcDetailBoard').textContent = post.board;
    document.getElementById('hcDetailTitle').textContent = post.title;
    const dateStr = post.created_at ? post.created_at.substring(0, 10) : '';
    document.getElementById('hcDetailMeta').textContent = (post.author || '') + (dateStr ? ' · ' + dateStr : '');
    const bodyEl = document.getElementById('hcDetailBody');

    if (post.preview) {
      bodyEl.innerHTML = '<div style="white-space:pre-wrap;line-height:1.9">' + escHtml(post.preview) + '</div>';
    } else {
      bodyEl.innerHTML = '<div class="hc-post-detail-loading">내용 없음</div>';
    }

    document.getElementById('hcPostDetailOverlay').classList.add('open');

    fetch(API + '/api/posts/' + post.post_id)
      .then(r => r.json())
      .then(d => {
        if (d.content) {
          bodyEl.innerHTML = '<div style="white-space:pre-wrap;line-height:1.9">' + escHtml(d.content) + '</div>';
        }
      })
      .catch(() => {});
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
