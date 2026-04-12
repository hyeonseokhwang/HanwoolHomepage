// SmartEditor2 integration shim
// Waits for SmartEditor to load and attaches paste/drop handlers to upload images
(function () {
  // Debug logger
  const DBG = {
    log: (...a) => console.log('[SE2][DBG]', new Date().toISOString(), ...a),
    warn: (...a) => console.warn('[SE2][DBG]', new Date().toISOString(), ...a),
    err: (...a) => console.error('[SE2][DBG]', new Date().toISOString(), ...a),
  };

  // Debug flags
  window.SE2_DEBUG_FULL = window.SE2_DEBUG_FULL !== undefined ? window.SE2_DEBUG_FULL : true;
  window.SE2_REMOTE_CLIPLOG = window.SE2_REMOTE_CLIPLOG !== undefined ? window.SE2_REMOTE_CLIPLOG : true;

  function dumpStr(label, s) {
    try {
      const len = (s || '').length;
      const cap = window.SE2_DEBUG_FULL ? len : Math.min(len, 3000);
      const head = (s || '').slice(0, cap);
      const note = cap < len ? ` [TRUNCATED ${len - cap}/${len}]` : '';
      console.log(`[SE2][CLIP] ${label}: len=${len}${note}\n`, head);
    } catch (e) { console.warn('[SE2][DBG] dumpStr error', e); }
  }

  function logClipboardDump(evt) {
    try {
      const cd = evt && evt.clipboardData;
      const html = (() => { try { return cd?.getData('text/html') || ''; } catch { return ''; } })();
      const rtf = (() => { try { return cd?.getData('text/rtf') || ''; } catch { return ''; } })();
      const txt = (() => { try { return cd?.getData('text/plain') || ''; } catch { return ''; } })();
      const items = Array.from(cd?.items || []);
      const files = Array.from(cd?.files || []);
      DBG.log('PASTE dump: itemTypes=', items.map(i => i.type), 'files=', files.map(f => ({ name: f.name, size: f.size, type: f.type })));
      dumpStr('text/html', html);
      dumpStr('text/rtf', rtf);
      dumpStr('text/plain', txt);
      const hasFileUrls = /file:\/\//i.test(html || '');
      const hasDataImg = /data:image\//i.test(html || '');
      DBG.log('PASTE flags', { hasFileUrls, hasDataImg, rtfPict: /\\pict/.test(rtf || '') });

      try {
        const save = { html, rtf, txt, time: Date.now() };
        localStorage.setItem('SE2_LAST_CLIP', JSON.stringify(save));
        // If auto-repeat is requested, schedule after this paste completes
        const n = Number(window.SE2_AUTO_REPEAT_ON_SAVE || 0);
        if (n > 0 && typeof window.SE2_repeatPasteFromLast === 'function' && !window.__SE2_REPEAT_SCHEDULED) {
          window.__SE2_REPEAT_SCHEDULED = true;
          setTimeout(() => { try { window.SE2_repeatPasteFromLast(n, 800); } catch {} }, 1500);
        }
      } catch {}

      if (window.SE2_REMOTE_CLIPLOG) {
        const plainFromHtml = (html || '').replace(/<[^>]*>/g, '');
        const corpus = [txt || '', plainFromHtml].join('\n');
        const count = (sub) => { try { const re = new RegExp(sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); const m = corpus.match(re); return m ? m.length : 0; } catch { return 0; } };
        const c1 = count('그림입니다. 원본 그림의 이름');
        const c2 = count('원본 그림의 이름');
        const localVerdict = (c1 >= 2 || c2 >= 2) ? 'fail' : 'pass';
        const payload = {
          html,
          rtf,
          text: txt,
          itemTypes: items.map(i => i.type),
          files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
          flags: { hasFileUrls, hasDataImg, rtfPict: /\\pict/.test(rtf || '') },
          ua: navigator.userAgent,
          referrer: document.referrer || location.href,
          verdict: localVerdict,
        };
        try {
          fetch('/api/log/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(r => r.json()).then(j => { if (j && j.verdict) DBG.log('CLIP verdict(server):', j.verdict, j.reason || ''); }).catch(() => { });
        } catch {}
      }
    } catch (e) { DBG.warn('logClipboardDump error', e); }
  }

  // Busy/overlay
  window.PASTE_BUSY = false;
  async function withOverlay(doc, label, fn) {
    const d = doc || document;
    let overlay;
    try {
      window.PASTE_BUSY = true;
      overlay = d.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
        background: 'rgba(255,255,255,0.65)', color: '#111', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 999999,
        fontFamily: 'sans-serif', fontSize: '14px'
      });
      const labelBox = d.createElement('div');
      labelBox.style.padding = '16px 20px';
      labelBox.style.background = 'rgba(255,255,255,0.9)';
      labelBox.style.border = '1px solid #ddd';
      labelBox.style.borderRadius = '8px';
      const textEl = d.createElement('div');
      textEl.style.fontWeight = '600';
      textEl.textContent = label || '이미지 업로드 중…';
      const subEl = d.createElement('div');
      subEl.style.marginTop = '6px';
      subEl.style.fontSize = '12px';
      subEl.style.opacity = '0.8';
      subEl.textContent = '';
      labelBox.appendChild(textEl);
      labelBox.appendChild(subEl);
      overlay.appendChild(labelBox);
      d.body && d.body.appendChild(overlay);
      const update = (mainText, subText) => {
        if (typeof mainText === 'string') textEl.textContent = mainText;
        if (typeof subText === 'string') subEl.textContent = subText;
      };
      return await fn(update);
    } finally {
      try { overlay && overlay.remove(); } catch {}
      window.PASTE_BUSY = false;
    }
  }

  // HWP JSON -> data URLs
  function parseHwpJsonForDataUrls(html) {
    try {
      const m = html && html.match(/<!--\[data-hwpjson]\s*({[\s\S]*?})\s*-->/i);
      if (!m) return [];
      const root = JSON.parse(m[1]);
      const bidt = new Map();
      const srMeta = new Map();
      const srOrder = [];
      const seen = new Set();
      const collect = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.bidt && typeof obj.bidt === 'object') {
          for (const [k, v] of Object.entries(obj.bidt)) {
            if (typeof v === 'string' && v.length > 50) bidt.set(String(k), v);
          }
        }
        if (typeof obj.bi === 'string') {
          if (!seen.has(obj.bi)) { srOrder.push(obj.bi); seen.add(obj.bi); }
          if (obj.ty && typeof obj.ty === 'string') srMeta.set(obj.bi, { ty: obj.ty });
        }
        if (Array.isArray(obj.bi)) {
          for (const it of obj.bi) {
            if (it && typeof it.sr === 'string') {
              if (!seen.has(it.sr)) { srOrder.push(it.sr); seen.add(it.sr); }
              if (it.ty && typeof it.ty === 'string') srMeta.set(it.sr, { ty: it.ty });
            }
          }
        }
        if (obj.img && typeof obj.img === 'object' && typeof obj.img.bi === 'string') {
          if (!seen.has(obj.img.bi)) { srOrder.push(obj.img.bi); seen.add(obj.img.bi); }
        }
        for (const k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) collect(obj[k]);
      };
      collect(root);
      const mimeFor = (sr) => {
        const meta = srMeta.get(sr);
        if (meta && meta.ty && /^image\//.test(meta.ty)) return meta.ty;
        if (/\.jpe?g$/i.test(sr)) return 'image/jpeg';
        if (/\.png$/i.test(sr)) return 'image/png';
        if (/\.gif$/i.test(sr)) return 'image/gif';
        return 'image/png';
      };
      const dataUrls = [];
      for (const sr of srOrder) {
        const b64 = bidt.get(sr);
        if (!b64) continue;
        dataUrls.push(`data:${mimeFor(sr)};base64,${b64}`);
      }
      return dataUrls;
    } catch { return []; }
  }

  function collectDataUrlsFromHTML(html) {
    if (!html) return [];
    const re = /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/g;
    const found = html.match(re) || [];
    return Array.from(new Set(found));
  }

  function replaceDataUrlsInHTMLWithMap(html, map) {
    let out = html;
    for (const [du, url] of map.entries()) {
      const esc = du.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(esc, 'g'), url);
    }
    return out;
  }

  function collectDataUrlsFromRTF(clipRTF) {
    try {
      if (!clipRTF || clipRTF.indexOf('\\pict') === -1) return [];
      const pictRe = /\\pict[\s\S]*?\}/g;
      const matches = clipRTF.match(pictRe) || [];
      const out = [];
      for (const block of matches) {
        const isPng = /\\pngblip/.test(block);
        const isJpg = /\\jpegblip/.test(block) || /\\jpgblip/.test(block);
        if (!isPng && !isJpg) continue;
        const mime = isPng ? 'image/png' : 'image/jpeg';
        const hex = block.replace(/[^0-9A-Fa-f]/g, '');
        if (!hex || hex.length < 20) continue;
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        if (bytes.length < 512) continue;
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = typeof btoa === 'function' ? btoa(bin) : '';
        if (b64) out.push(`data:${mime};base64,${b64}`);
      }
      return out;
    } catch { return []; }
  }

  async function uploadQueue(tasks, concurrency = 2, onProgress) {
    const results = new Array(tasks.length).fill(null);
    let completed = 0;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        const t = tasks[i];
        try {
          if (t.kind === 'dataUrl') {
            const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: t.dataUrl }) });
            const j = await res.json();
            results[i] = j && j.url ? j.url : null;
          } else if (t.kind === 'file' || t.kind === 'blob') {
            const form = new FormData();
            form.append('file', t.file || t.blob, t.name || 'pasted.png');
            const res = await fetch('/api/upload', { method: 'POST', body: form });
            const j = await res.json();
            results[i] = j && j.url ? j.url : null;
          } else {
            results[i] = null;
          }
        } catch { results[i] = null; }
        finally {
          completed++;
          try { if (typeof onProgress === 'function') onProgress(completed, tasks.length, t); } catch {}
        }
      }
    };
    const workers = [];
    const cc = Math.max(1, Math.min(concurrency, tasks.length || 1));
    for (let k = 0; k < cc; k++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function prioritizeJpgTasks(tasks) {
    const score = (t) => {
      let mime = t.mime || '';
      if (!mime && t.dataUrl) { const m = t.dataUrl.match(/^data:([^;]+);/i); if (m) mime = m[1].toLowerCase(); }
      if (!mime && t.file && t.file.type) mime = String(t.file.type).toLowerCase();
      const name = String(t.name || '').toLowerCase();
      const isJpg = mime === 'image/jpeg' || /\.jpe?g$/.test(name);
      return isJpg ? 0 : 1;
    };
    // Stable sort: decorate-sort-undecorate to preserve original order among equals
    return tasks
      .map((t, idx) => ({ t, idx, s: score(t) }))
      .sort((a, b) => (a.s - b.s) || (a.idx - b.idx))
      .map(x => x.t);
  }

  // Replace file:/// image-like srcs in HTML with provided URLs in DOM order
  function replaceFileImageSrcsWith(html, urls) {
    try {
      if (!html || !urls || !urls.length) return html;
      const container = document.createElement('div');
      // XSS 방지: DOMPurify로 sanitize 후 삽입 (미로드 시 원본 사용)
      container.innerHTML = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
        : html;
      let idx = 0;
      const nodesWithSrc = Array.from(container.querySelectorAll('[src^="file:"]'));
      for (const el of nodesWithSrc) {
        if (idx >= urls.length) { el.removeAttribute('src'); continue; }
        const newUrl = urls[idx++];
        if (el.tagName && el.tagName.toLowerCase() === 'img') {
          const wAttr = el.getAttribute('width');
          const hAttr = el.getAttribute('height');
          const style = el.getAttribute('style') || '';
          const needsW = wAttr && /[a-zA-Z%]/.test(wAttr);
          const needsH = hAttr && /[a-zA-Z%]/.test(hAttr);
          let newStyle = style;
          if (needsW) { newStyle += (newStyle && !newStyle.trim().endsWith(';') ? ';' : ''); newStyle += `width:${wAttr};`; el.removeAttribute('width'); }
          if (needsH) { newStyle += (newStyle && !newStyle.trim().endsWith(';') ? ';' : ''); newStyle += `height:${hAttr};`; el.removeAttribute('height'); }
          if (newStyle !== style) el.setAttribute('style', newStyle);
        }
        el.setAttribute('src', newUrl);
      }
      // Also sanitize CSS background-image:url(file:...)
      const all = Array.from(container.querySelectorAll('*'));
      for (const el of all) {
        const style = el.getAttribute('style') || '';
        if (!style) continue;
        if (/url\((['"])?.*?file:[^)]*\)/i.test(style)) {
          el.setAttribute('style', style.replace(/url\((['"])?.*?file:[^)]*\)/gi, 'none'));
        }
      }
      return container.innerHTML;
    } catch { return html; }
  }

  // Attach to SmartEditor instance (with retry for iframe not yet loaded)
  window.seInitAttachToEditor = function (editor, _retryCount) {
    const retryCount = _retryCount || 0;
    try {
      const iframe = editor && editor.elIRFrame;
      const doc = iframe && (iframe.contentDocument || iframe.contentWindow?.document);
      if (!doc) {
        if (retryCount < 30) {
          DBG.log('editor document not ready, retry', retryCount + 1, '/ 30');
          setTimeout(() => window.seInitAttachToEditor(editor, retryCount + 1), 500);
          return;
        }
        DBG.warn('no editor document after 30 retries');
        return;
      }

      async function uploadBlob(blob, suggestedName) {
        const form = new FormData();
        form.append('file', blob, suggestedName || 'pasted.png');
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        return res.json();
      }
      const isHttpUrl = (u) => /^https?:\/\//i.test(u);

      async function replaceDataUrlsInHTML(html) {
        if (!html) return html;
        const dataUrlRe = /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/g;
        const found = html.match(dataUrlRe) || [];
        if (!found.length) return html;
        const unique = Array.from(new Set(found));
        const map = new Map();
        await Promise.all(unique.map(async (du) => {
          try {
            const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: du }) });
            const data = await res.json();
            if (data && data.url) map.set(du, data.url);
          } catch {}
        }));
        if (!map.size) return html;
        let out = html;
        for (const [du, url] of map.entries()) {
          const esc = du.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          out = out.replace(new RegExp(esc, 'g'), url);
        }
        return out;
      }

      async function extractAndInsertFromRTF(clipRTF) {
        try {
          if (!clipRTF || clipRTF.indexOf('\\pict') === -1) return 0;
          const pictRe = /\\pict[\s\S]*?\}/g;
          const matches = clipRTF.match(pictRe) || [];
          let inserted = 0;
          for (const block of matches) {
            const isPng = /\\pngblip/.test(block);
            const isJpg = /\\jpegblip/.test(block) || /\\jpgblip/.test(block);
            if (!isPng && !isJpg) continue;
            const mime = isPng ? 'image/png' : 'image/jpeg';
            const hex = block.replace(/[^0-9A-Fa-f]/g, '');
            if (!hex || hex.length < 20) continue;
            try {
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
              if (bytes.length < 512) continue;
              const blob = new Blob([bytes], { type: mime });
              const up = await uploadBlob(blob, 'rtf-pasted');
              if (up && up.url) { editor.exec('PASTE_HTML', [`<img src="${up.url}" style="max-width:100%;" alt="rtf-pasted-image" />`]); inserted++; }
            } catch {}
          }
          return inserted;
        } catch { return 0; }
      }

      async function replaceInlineDataAndBlobImages() {
        const imgs = Array.from(doc.querySelectorAll('img'));
        for (const img of imgs) {
          const src = img.getAttribute('src') || '';
          if (!src || isHttpUrl(src)) continue;
          try {
            if (src.startsWith('data:image/')) {
              const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: src }) });
              const data = await res.json();
              if (data.url) img.src = data.url;
            } else {
              const r = await fetch(src);
              const b = await r.blob();
              const data = await uploadBlob(b, (img.alt || 'pasted') + '.png');
              if (data.url) img.src = data.url;
            }
          } catch (e) { DBG.warn('failed to replace image src', src, e); }
        }
        const all = Array.from(doc.querySelectorAll('*'));
        for (const el of all) {
          const style = el.style;
          if (!style || !style.backgroundImage) continue;
          const m = style.backgroundImage.match(/url\(("|')?(.*?)(\1)?\)/i);
          if (!m) continue;
          const url = m[2] || '';
          if (!url || isHttpUrl(url)) continue;
          try {
            if (url.startsWith('data:image/')) {
              const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: url }) });
              const data = await res.json();
              if (data.url) style.backgroundImage = `url(${data.url})`;
            } else {
              const r = await fetch(url);
              const b = await r.blob();
              const data = await uploadBlob(b, 'bg-pasted.png');
              if (data.url) style.backgroundImage = `url(${data.url})`;
            }
          } catch (e) { DBG.warn('failed to replace background image', url, e); }
        }
      }

      async function reportFinalContent() {
        try {
          const html = doc && doc.body ? doc.body.innerHTML : '';
          const text = doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
          const res = await fetch('/api/log/final', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html, text }) });
          const j = await res.json();
          DBG.log('FINAL verdict(server):', j && j.verdict, j && j.reason);
          return j;
        } catch (e) { DBG.warn('final report failed', e); return null; }
      }

  const onPaste = async (event) => {
        if (window.PASTE_BUSY) { event.preventDefault(); DBG.warn('paste ignored: busy'); return; }
        try { logClipboardDump(event); } catch {}
        const clipHTML = (() => { try { return event.clipboardData?.getData('text/html') || ''; } catch { return ''; } })();
        const clipRTF = (() => { try { return event.clipboardData?.getData('text/rtf') || ''; } catch { return ''; } })();
        const clipText = (() => { try { return event.clipboardData?.getData('text/plain') || ''; } catch { return ''; } })();
        const items = event.clipboardData?.items || [];
        const imageItems = [];
        for (const item of items) { if (item.type?.indexOf && item.type.indexOf('image') === 0) imageItems.push(item); }
        const hasFileUrls = /src\s*=\s*["']?file:\/\//i.test(clipHTML || '') || /file:\/\//i.test(clipHTML || '');
        DBG.log('paste: counts', { imageItems: imageItems.length, htmlLen: (clipHTML || '').length, rtfLen: (clipRTF || '').length, hasFileUrls });

        if (imageItems.length) {
          event.preventDefault();
          await withOverlay(doc, `이미지 ${imageItems.length}개 업로드 중…`, async (update) => {
            let tasks = [];
            for (let i=0;i<imageItems.length;i++) { const it=imageItems[i]; const f = it.getAsFile(); if (f) tasks.push({ kind: 'file', file: f, name: f.name || 'pasted.png', origIndex: i, mime: f.type||'' }); }
            const total = tasks.length;
            tasks = prioritizeJpgTasks(tasks);
            const urls = await uploadQueue(tasks, 3, (done) => update(`이미지 업로드 중… (${done}/${total})`, 'JPG 우선 업로드'));
            // Restore original order for rendering
            const byOrig = new Array(total).fill(null);
            tasks.forEach((t, idx) => { if (typeof t.origIndex === 'number') byOrig[t.origIndex] = urls[idx]; });
            const html = byOrig.filter(Boolean).map(u => `<img src="${u}" style="max-width:100%;" alt="pasted-image" />`).join('');
            if (html) editor.exec('PASTE_HTML', [html]);
            setTimeout(reportFinalContent, 50);
          });
          return;
        } else if (clipHTML && /data:image\//i.test(clipHTML)) {
          event.preventDefault();
          const duList = collectDataUrlsFromHTML(clipHTML);
          await withOverlay(doc, `이미지 ${duList.length}개 업로드 중…`, async (update) => {
            let tasks = duList.map((du, i) => {
              const m = du.match(/^data:([^;]+);/i);
              const mime = (m && m[1]) ? m[1].toLowerCase() : '';
              return { kind: 'dataUrl', dataUrl: du, key: du, mime, origIndex: i };
            });
            const total = tasks.length;
            tasks = prioritizeJpgTasks(tasks);
            const urls = await uploadQueue(tasks, 3, (done) => update(`이미지 업로드 중… (${done}/${total})`, 'JPG 우선 업로드'));
            const map = new Map();
            tasks.forEach((t, idx) => { if (urls[idx]) map.set(t.key, urls[idx]); });
            const transformed = replaceDataUrlsInHTMLWithMap(clipHTML, map);
            editor.exec('PASTE_HTML', [transformed]);
            setTimeout(reportFinalContent, 50);
          });
          return;
        } else if (hasFileUrls) {
          event.preventDefault();
          await withOverlay(doc, '이미지 업로드 중…', async (update) => {
            const duList = collectDataUrlsFromHTML(clipHTML);
            const hwpDus = parseHwpJsonForDataUrls(clipHTML);
            if ((duList.length + hwpDus.length) > 0) {
              let tasks = [];
              tasks.push(...duList.map((du, i) => { const m = du.match(/^data:([^;]+);/i); const mime = (m && m[1]) ? m[1].toLowerCase() : ''; return { kind: 'dataUrl', dataUrl: du, group: 'du', key: du, mime, origIndex: i }; }));
              tasks.push(...hwpDus.map((du, i) => { const m = du.match(/^data:([^;]+);/i); const mime = (m && m[1]) ? m[1].toLowerCase() : ''; return { kind: 'dataUrl', dataUrl: du, group: 'hwp', hwpIndex: i, mime }; }));
              const total = tasks.length;
              tasks = prioritizeJpgTasks(tasks);
              const urls = await uploadQueue(tasks, 3, (done) => update(`이미지 업로드 중… (${done}/${total})`, 'JPG 우선 업로드'));
              // Build outputs
              const map = new Map();
              const hwpCollected = [];
              tasks.forEach((t, idx) => {
                const u = urls[idx]; if (!u) return;
                if (t.group === 'du') map.set(t.key, u);
                else if (t.group === 'hwp') hwpCollected.push({ idx: t.hwpIndex, url: u });
              });
              let transformed = replaceDataUrlsInHTMLWithMap(clipHTML, map);
              if (hwpCollected.length) {
                const ordered = hwpCollected.sort((a,b)=>a.idx-b.idx).map(x=>x.url);
                transformed = replaceFileImageSrcsWith(transformed, ordered);
              }
              editor.exec('PASTE_HTML', [transformed]);
              setTimeout(reportFinalContent, 50);
              return;
            }
            const rtfDus = collectDataUrlsFromRTF(clipRTF);
            if (rtfDus.length) {
              let tasks = rtfDus.map((du, i) => { const m = du.match(/^data:([^;]+);/i); const mime = (m && m[1]) ? m[1].toLowerCase() : ''; return { kind: 'dataUrl', dataUrl: du, mime, origIndex: i }; });
              const total = tasks.length;
              tasks = prioritizeJpgTasks(tasks);
              const urls = await uploadQueue(tasks, 2, (done) => update(`이미지 업로드 중… (${done}/${total})`, 'JPG 우선 업로드'));
              // Restore original order for rendering
              const byOrig = new Array(total).fill(null);
              tasks.forEach((t, idx) => { if (typeof t.origIndex === 'number') byOrig[t.origIndex] = urls[idx]; });
              const htmlImgs = byOrig.filter(Boolean).map(u => `<img src="${u}" style="max-width:100%;" alt="rtf-pasted-image" />`).join('');
              let sanitized = clipHTML
                ? clipHTML.replace(/<img\b[^>]*\bsrc\s*=\s*['"]?file:[^'">]*['"]?[^>]*>/gi, '').replace(/url\((['"])?.*?file:[^)]*\)/gi, 'none')
                : (clipText || '');
              editor.exec('PASTE_HTML', [sanitized + htmlImgs]);
              setTimeout(reportFinalContent, 50);
              return;
            }
            const sanitized = clipHTML
              ? clipHTML.replace(/<img\b[^>]*\bsrc\s*=\s*['"]?file:[^'">]*['"]?[^>]*>/gi, '').replace(/url\((['"])?.*?file:[^)]*\)/gi, 'none')
              : (clipText || '');
            editor.exec('PASTE_HTML', [sanitized]);
            setTimeout(reportFinalContent, 50);
          });
          return;
        } else {
          setTimeout(async () => {
            try {
              const sel = (doc.getSelection && doc.getSelection()) || (doc.selection && doc.selection);
              if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0).cloneRange();
                const container = doc.createElement('div');
                container.appendChild(range.cloneContents());
                const candidateImgs = Array.from(container.querySelectorAll('img'));
                for (const cimg of candidateImgs) {
                  const src = cimg.getAttribute('src') || '';
                  if (!src) continue;
                  try {
                    if (src.startsWith('data:image/')) {
                      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: src }) });
                      const data = await res.json();
                      if (data.url) editor.exec('PASTE_HTML', [`<img src="${data.url}" style="max-width:100%;" alt="pasted-image" />`]);
                    } else if (!isHttpUrl(src)) {
                      const r = await fetch(src);
                      const b = await r.blob();
                      const data = await uploadBlob(b, 'pasted.png');
                      if (data.url) editor.exec('PASTE_HTML', [`<img src="${data.url}" style="max-width:100%;" alt="pasted-image" />`]);
                    }
                  } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }
            await replaceInlineDataAndBlobImages();
            DBG.log('post-paste replacement pass completed');
            setTimeout(reportFinalContent, 50);
          }, 150);
        }
      };

      // Test utilities
      window.SE2_setTestSample = function (sample) {
        try { localStorage.setItem('SE2_TEST_SAMPLE', JSON.stringify(sample || {})); } catch {}
      };
      function loadTestSample() {
        try { const sHard = JSON.parse(localStorage.getItem('SE2_TEST_SAMPLE') || 'null'); if (sHard && (sHard.html || sHard.rtf || sHard.txt)) return sHard; } catch {}
        try { const sLast = JSON.parse(localStorage.getItem('SE2_LAST_CLIP') || 'null'); if (sLast && (sLast.html || sLast.rtf || sLast.txt)) return { html: sLast.html, rtf: sLast.rtf, txt: sLast.txt }; } catch {}
        return null;
      }
      window.SE2_repeatPasteFromLast = async function (n = 20, delayMs = 800) {
        const sample = loadTestSample();
        if (!sample) { DBG.warn('테스트 샘플이 없습니다. 실제로 한번 붙여넣기 후 실행하세요.'); return; }
        for (let i = 1; i <= n; i++) {
          DBG.log(`SE2 테스트 반복 ${i}/${n} 시작`);
          const fakeEvent = {
            preventDefault: () => { },
            clipboardData: {
              getData: (t) => { if (t === 'text/html') return sample.html || ''; if (t === 'text/rtf') return sample.rtf || ''; if (t === 'text/plain') return sample.txt || ''; return ''; },
              items: [], files: [],
            }
          };
          try { await onPaste(fakeEvent); } catch (e) { DBG.warn('simulate onPaste error', e); }
          const t0 = Date.now();
          while (window.PASTE_BUSY) { if (Date.now() - t0 > 60000) break; await new Promise(r => setTimeout(r, 50)); }
          await new Promise(r => setTimeout(r, Math.max(50, delayMs)));
          await reportFinalContent();
          DBG.log(`SE2 테스트 반복 ${i}/${n} 완료`);
        }
        DBG.log('SE2 테스트 반복 종료');
      };

      const onDrop = async (e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length) {
          e.preventDefault();
          const tasks = [];
          for (const file of files) { if (file.type && file.type.startsWith('image/')) tasks.push({ kind: 'file', file, name: file.name || 'dropped.png' }); }
          if (tasks.length) {
            await withOverlay(doc, `이미지 ${tasks.length}개 업로드 중…`, async () => {
              const urls = await uploadQueue(tasks, 2);
              const html = urls.filter(Boolean).map(u => `<img src="${u}" style="max-width:100%;" alt="dropped-image" />`).join('');
              if (html) editor.exec('PASTE_HTML', [html]);
              setTimeout(reportFinalContent, 50);
            });
          }
        }
      };

      doc.addEventListener('paste', onPaste);
      doc.addEventListener('drop', onDrop);
      doc.addEventListener('dragover', (ev) => ev.preventDefault());

      // Force focus/edit mode on click/mousedown
      const forceEdit = () => {
        try {
          if (typeof editor.exec === 'function') { editor.exec('FOCUS'); editor.exec('ENABLE_WYSIWYG'); }
          if (doc.body) doc.body.focus();
        } catch {}
      };
      doc.addEventListener('click', forceEdit);
      doc.addEventListener('mousedown', forceEdit);

      DBG.log('handlers attached to SmartEditor document');
      try { if (typeof editor.exec === 'function') { editor.exec('FOCUS'); editor.exec('ENABLE_WYSIWYG'); } } catch {}
    } catch (e) { DBG.err('failed to attach handlers', e); }
  };

  // Fallback: if editor is inside an outer iframe
  function attachViaIframePolling(outerIframe) {
    let tries = 0;
    const MAX_TRIES = 120; // ~60s
    const timer = setInterval(() => {
      tries++;
      try {
        const cw = outerIframe.contentWindow; if (!cw) return;
        const oEditors = cw.oEditors;
        let editor = null;
        if (oEditors) {
          if (oEditors.getById && typeof oEditors.getById === 'object' && oEditors.getById['ir1']) editor = oEditors.getById['ir1'];
          else if (Array.isArray(oEditors) && oEditors.length > 0) editor = oEditors[0];
        }
        if (editor && editor.elIRFrame) { clearInterval(timer); console.log('se-init: editor found via polling fallback'); window.seInitAttachToEditor(editor); }
      } catch {}
      if (tries >= MAX_TRIES) { clearInterval(timer); console.warn('se-init: polling fallback timed out'); }
    }, 500);
  }

  window.addEventListener('load', () => {
    const outer = document.getElementById('se-iframe');
    if (outer) outer.addEventListener('load', () => attachViaIframePolling(outer));
  });

  // Allow auto-repeat via query param: ?autoRepeat=20 (runs after first paste is captured)
  window.addEventListener('load', () => {
    try {
      const params = new URLSearchParams(location.search || '');
      const nStr = params.get('autoRepeat');
      const n = nStr ? parseInt(nStr, 10) : 0;
      if (n && n > 0) {
        window.SE2_AUTO_REPEAT_ON_SAVE = n;
        // If a sample already exists, try to run immediately
        const s = localStorage.getItem('SE2_LAST_CLIP');
        if (s && typeof window.SE2_repeatPasteFromLast === 'function') {
          setTimeout(() => { try { window.SE2_repeatPasteFromLast(n, 800); } catch {} }, 800);
        } else {
          console.log('[SE2][DBG] autoRepeat armed; paste once to capture clipboard then auto-run');
        }
      }
    } catch {}
  });
})();
