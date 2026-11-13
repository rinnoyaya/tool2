(() => {
  const $ = id => document.getElementById(id);
  const e = Object.fromEntries(['storyTitle','story','width','height','fontSize','font','padding','paddingValue','bg','ink','light','watermarkFile','watermarkThumb','watermarkStatus','removeWatermark','watermarkOpacity','watermarkOpacityValue','watermarkSize','watermarkSizeValue','generate','message','draftStatus','clearDraft','resultCount','emptyPreview','pageCanvas','cardFrame','cutLayer','addCut','removeCut','resetCuts','prev','next','pageLabel','exportPreview','exportCanvas','share','downloadPage','downloadAll','lineHeight','lineHeightValue','indent','fixedHeight','storyCount','sizePresets','themes'].map(id => [id, $(id)]));
  const draftFields = ['storyTitle','story','width','height','fontSize','font','padding','bg','ink','light','watermarkOpacity','watermarkSize','lineHeight','indent','fixedHeight'];
  const getValue = id => e[id].type === 'checkbox' ? String(e[id].checked) : e[id].value;
  const setValue = (id, value) => { if (e[id].type === 'checkbox') e[id].checked = value === 'true'; else e[id].value = value; };
  const draftDefaults = Object.fromEntries(draftFields.map(id => [id, getValue(id)]));
  function syncOutputs() {
    e.paddingValue.textContent = e.padding.value + ' px';
    e.lineHeightValue.textContent = Number(e.lineHeight.value).toFixed(2).replace(/0$/, '') + ' 倍';
    e.watermarkOpacityValue.textContent = e.watermarkOpacity.value + '%';
    e.watermarkSizeValue.textContent = e.watermarkSize.value + '%';
    for (const button of e.sizePresets.children) button.classList.toggle('active', button.dataset.w === e.width.value && button.dataset.h === e.height.value);
    for (const button of e.themes.children) button.classList.toggle('active', button.dataset.bg === e.bg.value && button.dataset.ink === e.ink.value && button.dataset.light === e.light.value);
  }
  function updateCount() {
    const lines = sourceLines();
    const chars = [...lines.join('')].filter(ch => ch !== '*' && !/\s/.test(ch)).length;
    e.storyCount.textContent = chars ? chars + ' 字 · ' + lines.length + ' 段' : '0 字';
  }
  let draftDb, draftTimer, draftWrite = Promise.resolve(), draftEpoch = 0, draftTouched = false;
  function openDraftDb() {
    if (!draftDb) draftDb = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(Error('此瀏覽器無法使用裝置暫存')); return; }
      const request = indexedDB.open('story-cards-device-draft', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts');
        request.result.createObjectStore('assets');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return draftDb;
  }
  async function draftRequest(mode, operation, storeName = 'drafts') {
    const db = await openDraftDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  function queueDraft() {
    draftTouched = true;
    clearTimeout(draftTimer);
    e.draftStatus.textContent = '正在暫存…';
    const epoch = draftEpoch;
    draftTimer = setTimeout(() => {
      const values = Object.fromEntries(draftFields.map(id => [id, getValue(id)]));
      const snapshot = { values, cuts: [...cuts], cutsReady, current };
      draftWrite = draftWrite.catch(() => {}).then(() => draftRequest('readwrite', store => store.put(snapshot, 'current')));
      draftWrite.then(() => { if (epoch === draftEpoch) e.draftStatus.textContent = '已暫存在此裝置'; }, () => {
        if (epoch === draftEpoch) e.draftStatus.textContent = '暫存失敗，請確認裝置剩餘空間';
      });
    }, 300);
  }
  const canvas = e.pageCanvas;
  const fontStack = {
    sans: '-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif',
    serif: '"Noto Serif TC","Songti TC",serif',
    round: '"Arial Rounded MT Bold","Noto Sans TC",sans-serif',
    mono: '"SFMono-Regular",Consolas,"Noto Sans Mono CJK TC",monospace'
  };
  let pages = [], ops = [], safeCuts = [], cuts = [], cutsReady = false, totalHeight = 0, current = 0, settings, titleLayout, timer, sourceKey = '', readyFiles = null, readyAlpha = null, readySize = null, readyImage = null, renderVersion = 0, drag = null, cutMode = '', previewExtras = [], watermarkImage = null, watermarkUrl = '', watermarkName = '', uploadVersion = 0;
  const sourceLines = () => e.story.value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  function trackSource(source) {
    const key = source.join('\n');
    if (key !== sourceKey) { cuts = []; cutsReady = false; sourceKey = key; }
  }
  const number = (el, min, max) => {
    const value = Number(el.value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : min;
  };
  const notice = (message, error = false) => {
    e.message.textContent = message;
    e.message.classList.toggle('error', error === true);
    e.message.classList.toggle('warn', error === 'warn');
  };
  const font = size => size + 'px ' + (fontStack[e.font.value] || fontStack.sans);
  function characters(text) {
    const result = [];
    let faded = false;
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\\' && chars[i + 1] === '*') { result.push({ ch: '*', faded }); i++; continue; }
      if (ch === '*') { faded = !faded; continue; }
      result.push({ ch, faded });
    }
    return result;
  }
  // 中文排版：標點不放在行首、開括號不留在行尾（避頭尾）
  const NO_START = new Set([...'，。、！？；：」』）》〉】〕…—～．,.!?;:)]}%']);
  const NO_END = new Set([...'「『（《〈【〔([{']);
  function wrap(text, measure, maxWidth, firstIndent = 0) {
    const lines = [[]];
    let width = firstIndent;
    for (const item of characters(text)) {
      item.w = measure.measureText(item.ch).width;
      let line = lines.at(-1);
      if (width + item.w > maxWidth && line.length) {
        const carry = [];
        if (NO_START.has(item.ch)) {
          while (line.length > 1 && carry.length < 3) {
            carry.unshift(line.pop());
            if (!NO_START.has(carry[0].ch)) break;
          }
          if (carry.length && NO_START.has(carry[0].ch)) { line.push(...carry); carry.length = 0; }
        }
        while (line.length > 1 && NO_END.has(line.at(-1).ch) && carry.length < 4) carry.unshift(line.pop());
        lines.push(carry);
        line = carry;
        width = carry.reduce((sum, x) => sum + x.w, 0);
      }
      line.push(item);
      width += item.w;
    }
    return lines;
  }
  function layoutTitle() {
    const value = e.storyTitle.value.trim();
    const size = Math.round(Math.min(62, Math.max(30, settings.size * 1.1)));
    const lineHeight = Math.round(size * 1.38);
    const margin = Math.round(settings.padding * .55);
    const accentWidth = 20;
    const footerSize = Math.round(Math.min(30, Math.max(22, settings.size * .55)));
    const measure = document.createElement('canvas').getContext('2d');
    const titleFont = '700 ' + size + 'px ' + (fontStack[e.font.value] || fontStack.sans);
    measure.font = titleFont;
    const lines = [];
    let line = '';
    for (const ch of value) {
      if (line && measure.measureText(line + ch).width > settings.width - settings.padding * 2 - accentWidth) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
    if (line) lines.push(line);
    const headerHeight = lines.length ? margin + lines.length * lineHeight + Math.round(margin * .72) : 0;
    const footerHeight = Math.round(margin * .45) + footerSize + margin;
    return { lines, size, lineHeight, margin, accentWidth, footerSize, titleFont, headerHeight, footerHeight,
      chromeHeight: headerHeight + margin * 2 + footerHeight };
  }
  function paginate() {
    const source = sourceLines();
    trackSource(source);
    if (!source.length) { notice('請先貼上劇情文字。', true); return false; }
    const width = number(e.width, 480, 2000);
    const height = number(e.height, 500, 4000);
    const size = number(e.fontSize, 20, 100);
    const padding = Math.min(number(e.padding, 40, 200), Math.floor(width / 4));
    const lineHeight = Math.max(1.3, Math.min(2.4, Number(e.lineHeight.value) || 1.7));
    const leading = Math.round(size * lineHeight);
    const indent = e.indent.checked ? size * 2 : 0;
    if (height - padding * 2 < leading * 2) {
      notice('圖卡高度太小或留白太多，請調整設定。', true);
      return false;
    }
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font(size);
    const units = [];
    for (const [index, raw] of source.entries()) {
      const rule = raw === '---' || raw === '***';
      const quote = !rule && /^>\s?/.test(raw);
      const content = quote ? raw.replace(/^>\s?/, '') : raw;
      const x = padding + (quote ? Math.round(size * .65) : 0);
      const firstIndent = quote ? 0 : indent;
      const lines = rule ? [] : wrap(content, measure, width - padding - x, firstIndent);
      if (rule) units.push({ type: 'rule', gap: index ? Math.round(leading * .62) : 0 });
      else lines.forEach((line, lineIndex) => units.push({ type: 'text', line, x: x + (lineIndex ? 0 : firstIndent), quote, gap: index && !lineIndex ? Math.round(leading * .62) : 0 }));
    }
    let y = padding;
    ops = units.map(unit => {
      y += unit.gap;
      const op = { ...unit, startY: y, y: unit.type === 'rule' ? y + Math.round(leading * .38) : y };
      y += leading;
      return op;
    });
    totalHeight = Math.ceil(y + padding);
    if (totalHeight > 240000) { notice('內容太長，請縮短文字再產生圖卡。', true); return false; }
    safeCuts = ops.slice(1).map((op, index) => Math.round((ops[index].startY + leading + op.startY) / 2))
      .filter(position => position >= padding + leading && position <= totalHeight - padding - leading);
    settings = { width, height, size, padding, leading, fixed: e.fixedHeight.checked, bg: e.bg.value, ink: e.ink.value, light: e.light.value };
    titleLayout = layoutTitle();
    cuts = cutsReady ? cuts.filter(position => safeCuts.includes(position)) : automaticCuts();
    cutsReady = true;
    updatePages();
    schedulePrepare();
    current = Math.min(current, pages.length - 1);
    draw();
    pageNotice('已產生 ' + pages.length + ' 張圖卡。');
    return true;
  }
  function automaticCuts() {
    const result = [];
    let start = settings.padding;
    const end = totalHeight - settings.padding;
    const contentHeight = Math.max(settings.leading * 2, settings.height - titleLayout.chromeHeight);
    while (end - start > contentHeight) {
      const wanted = start + contentHeight;
      const available = safeCuts.filter(position => position > start + settings.leading * 2 && position < Math.min(start + 4000, end));
      if (!available.length) break;
      // 固定高度時取「放得下的最後一行」，避免超出設定高度；否則取最接近的位置
      const next = settings.fixed
        ? (available.filter(position => position <= wanted).pop() ?? available[0])
        : available.reduce((best, position) => Math.abs(position - wanted) < Math.abs(best - wanted) ? position : best);
      if (next <= start) break;
      result.push(next);
      start = next;
      if (result.length > 100) break;
    }
    return result;
  }
  const pageContentHeight = index => pages[index].end - pages[index].start
    - (index === 0 ? settings.padding : 0) - (index === pages.length - 1 ? settings.padding : 0);
  function overflowPages() {
    if (!settings.fixed) return [];
    return pages.map((_, index) => index).filter(index => pageContentHeight(index) + titleLayout.chromeHeight > settings.height);
  }
  function pageNotice(base) {
    const over = overflowPages();
    if (over.length) notice(base + ' 第 ' + over.map(i => i + 1).join('、') + ' 張內容超過設定高度，已自動加高；可調整切割線讓尺寸一致。', 'warn');
    else notice(base);
  }
  function updatePages() {
    cuts.sort((a, b) => a - b);
    pages = [0, ...cuts].map((start, index) => ({ start, end: cuts[index] ?? totalHeight }));
    current = Math.min(current, pages.length - 1);
  }
  function paintRegion(target, start, end, preview = false, transparent = false) {
    const { width, size, padding, leading, bg, ink, light } = settings;
    const scale = preview ? .5 : 1;
    target.width = Math.round(width * scale);
    target.height = Math.round((end - start) * scale);
    const context = target.getContext('2d');
    context.scale(scale, scale);
    if (!transparent) {
      context.fillStyle = bg;
      context.fillRect(0, 0, width, end - start);
    }
    context.textBaseline = 'top';
    context.font = font(size);
    for (const op of ops) {
      if (op.y + leading < start || op.y > end) continue;
      const y = op.y - start;
      if (op.type === 'rule') {
        context.fillStyle = light;
        context.fillRect(padding, y, width - padding * 2, 2);
        continue;
      }
      if (op.quote) {
        context.fillStyle = light;
        context.fillRect(padding, y, 4, leading * .82);
      }
      let x = op.x;
      for (const item of op.line) {
        context.fillStyle = item.faded ? light : ink;
        context.fillText(item.ch, x, y);
        x += context.measureText(item.ch).width;
      }
    }
  }
  const watermarkAlpha = () => number(e.watermarkOpacity, 0, 100) / 100;
  const watermarkSizeFactor = () => {
    const value = number(e.watermarkSize, 0, 100);
    return value <= 50 ? .15 + .85 * value / 50 : 1 + .35 * (value - 50) / 50;
  };
  function drawWatermark(context, top, height, alpha = watermarkAlpha(), sizeFactor = watermarkSizeFactor()) {
    if (!watermarkImage) return;
    if (alpha <= 0) return;
    const maxWidth = settings.width * .72;
    const maxHeight = Math.max(1, Math.min(height * .72, 900));
    const ratio = Math.min(maxWidth / watermarkImage.naturalWidth, maxHeight / watermarkImage.naturalHeight) * sizeFactor;
    const width = watermarkImage.naturalWidth * ratio;
    const imageHeight = watermarkImage.naturalHeight * ratio;
    context.save();
    context.globalAlpha = alpha;
    context.drawImage(watermarkImage, (settings.width - width) / 2, top + (height - imageHeight) / 2, width, imageHeight);
    context.restore();
  }
  function paint(target, index, alpha = watermarkAlpha(), sizeFactor = watermarkSizeFactor()) {
    const start = pages[index].start + (index === 0 ? settings.padding : 0);
    const end = pages[index].end - (index === pages.length - 1 ? settings.padding : 0);
    const content = document.createElement('canvas');
    paintRegion(content, start, end, false, true);
    const { width, padding, bg, ink, light } = settings;
    const { lines, lineHeight, margin, accentWidth, footerSize, titleFont, headerHeight, footerHeight } = titleLayout;
    const natural = content.height + headerHeight + margin * 2 + footerHeight;
    target.width = width;
    target.height = settings.fixed ? Math.max(settings.height, natural) : natural;
    const footerY = target.height - footerHeight;
    const context = target.getContext('2d');
    context.fillStyle = bg;
    context.fillRect(0, 0, width, target.height);
    context.textBaseline = 'top';
    drawWatermark(context, headerHeight + margin, footerY - margin - headerHeight - margin, alpha, sizeFactor);
    if (lines.length) {
      context.fillStyle = light;
      context.fillRect(padding, margin + 4, 5, Math.max(lineHeight - 8, lines.length * lineHeight - 8));
      context.fillStyle = ink;
      context.font = titleFont;
      lines.forEach((line, lineIndex) => context.fillText(line, padding + accentWidth, margin + lineIndex * lineHeight));
      context.save();
      context.globalAlpha = .45;
      context.fillStyle = light;
      context.fillRect(padding, headerHeight - 2, width - padding * 2, 2);
      context.restore();
    }
    context.drawImage(content, 0, headerHeight + margin);
    context.fillStyle = light;
    context.fillRect(padding, footerY, width - padding * 2, 2);
    const label = '第' + (index + 1) + '頁、共' + pages.length + '頁';
    context.font = footerSize + 'px ' + (fontStack[e.font.value] || fontStack.sans);
    context.fillText(label, (width - context.measureText(label).width) / 2, footerY + Math.round(margin * .45));
  }
  function refreshExportPreview() {
    if (!e.exportPreview.open || !pages.length) return;
    paint(e.exportCanvas, current);
    e.exportCanvas.hidden = false;
  }
  e.exportPreview.addEventListener('toggle', refreshExportPreview);
  function draw() {
    if (!pages.length) return;
    previewExtras.forEach(extra => extra.remove());
    previewExtras = [];
    for (let start = 0, part = 0; start < totalHeight; start += 3000, part++) {
      const target = part ? document.createElement('canvas') : canvas;
      paintRegion(target, start, Math.min(start + 3000, totalHeight), true);
      if (part) { e.cardFrame.insertBefore(target, e.cutLayer); previewExtras.push(target); }
    }
    canvas.hidden = false;
    e.emptyPreview.hidden = true;
    e.resultCount.textContent = pages.length + ' 張圖片';
    e.pageLabel.textContent = (current + 1) + ' / ' + pages.length;
    e.prev.disabled = current === 0;
    e.next.disabled = current === pages.length - 1;
    for (const id of ['share','downloadPage']) e[id].disabled = false;
    e.downloadAll.disabled = !readyFiles;
    e.addCut.disabled = safeCuts.length <= cuts.length;
    e.removeCut.disabled = !cuts.length;
    e.resetCuts.disabled = !safeCuts.length;
    renderCuts();
    refreshExportPreview();
  }
  function nearest(clientY, exclude = -1) {
    const rect = e.cardFrame.getBoundingClientRect();
    const y = (clientY - rect.top) / rect.height * totalHeight;
    const options = safeCuts.filter(position => position === exclude || !cuts.includes(position));
    return options.length ? options.reduce((best, position) => Math.abs(position - y) < Math.abs(best - y) ? position : best) : null;
  }
  function renderCuts() {
    e.cutLayer.hidden = false;
    e.cutLayer.replaceChildren();
    cuts.forEach((position, index) => {
      const line = document.createElement('div');
      line.className = 'cut-guide';
      line.style.top = (position / totalHeight * 100) + '%';
      line.setAttribute('role', 'slider');
      line.setAttribute('tabindex', '0');
      line.setAttribute('aria-label', '第 ' + (index + 1) + ' 條切割線');
      line.setAttribute('aria-valuemin', '0');
      line.setAttribute('aria-valuemax', String(totalHeight));
      line.setAttribute('aria-valuenow', String(position));
      line.innerHTML = '<span class="cut-handle" aria-hidden="true">≡</span><span class="cut-line"></span><span class="cut-number">' + (index + 1) + ' / ' + pages.length + '</span>';
      line.addEventListener('pointerdown', event => {
        event.stopPropagation();
        if (cutMode === 'remove') { cuts.splice(index, 1); finishCuts(); return; }
        event.preventDefault();
        drag = { index, original: position, element: line };
        line.setPointerCapture(event.pointerId);
        line.classList.add('dragging');
      });
      line.addEventListener('pointermove', event => {
        if (!drag || drag.element !== line) return;
        const proposed = nearest(event.clientY, drag.original);
        if (proposed !== null && proposed > (cuts[index - 1] ?? 0) + settings.leading && proposed < (cuts[index + 1] ?? totalHeight) - settings.leading) {
          drag.next = proposed;
          line.style.top = (proposed / totalHeight * 100) + '%';
        }
      });
      line.addEventListener('pointerup', () => {
        if (!drag || drag.element !== line) return;
        if (drag.next != null) cuts[index] = drag.next;
        drag = null;
        finishCuts();
      });
      line.addEventListener('pointercancel', () => { drag = null; renderCuts(); });
      line.addEventListener('keydown', event => {
        if (cutMode === 'remove' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); cuts.splice(index, 1); finishCuts(); return; }
        if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const next = safeCuts[safeCuts.indexOf(position) + delta];
        if (next != null && !cuts.includes(next) && next > (cuts[index - 1] ?? 0) + settings.leading && next < (cuts[index + 1] ?? totalHeight) - settings.leading) {
          cuts[index] = next; finishCuts(); e.cutLayer.children[index]?.focus();
        }
      });
      e.cutLayer.append(line);
    });
  }
  function finishCuts() {
    cutsReady = true;
    cutMode = '';
    e.addCut.classList.remove('active');
    e.removeCut.classList.remove('active');
    e.cardFrame.classList.remove('adding-cut');
    updatePages();
    schedulePrepare();
    draw();
    pageNotice('目前分成 ' + pages.length + ' 張圖卡。');
    queueDraft();
  }
  function toggleMode(mode) {
    cutMode = cutMode === mode ? '' : mode;
    e.addCut.classList.toggle('active', cutMode === 'add');
    e.removeCut.classList.toggle('active', cutMode === 'remove');
    e.cardFrame.classList.toggle('adding-cut', cutMode === 'add');
    notice(cutMode === 'add' ? '請點選預覽圖中要新增切割線的位置。' : cutMode === 'remove' ? '請點選要移除的切割線。' : '');
  }
  e.addCut.onclick = () => toggleMode('add');
  e.removeCut.onclick = () => toggleMode('remove');
  e.resetCuts.onclick = () => { cuts = automaticCuts(); finishCuts(); };
  e.cardFrame.addEventListener('click', event => {
    if (cutMode !== 'add' || event.target.closest('.cut-guide')) return;
    const position = nearest(event.clientY);
    if (position == null) return;
    cuts.push(position);
    finishCuts();
  });
  e.generate.onclick = () => {
    clearTimeout(timer);
    if (!paginate()) return;
    prepareFiles();
    if (matchMedia('(max-width: 960px)').matches) e.cardFrame.closest('.preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  function selectPage(index) {
    current = index;
    e.pageLabel.textContent = (current + 1) + ' / ' + pages.length;
    e.prev.disabled = current === 0;
    e.next.disabled = current === pages.length - 1;
    const body = e.cardFrame.parentElement;
    const rect = e.cardFrame.getBoundingClientRect();
    body.scrollTop += rect.top - body.getBoundingClientRect().top + pages[current].start / totalHeight * rect.height - 12;
    refreshExportPreview();
    queueDraft();
  }
  e.prev.onclick = () => { if (current > 0) selectPage(current - 1); };
  e.next.onclick = () => { if (current < pages.length - 1) selectPage(current + 1); };
  // 有文字就自動更新預覽，不必每次按「產生圖卡」
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!sourceLines().length) { if (pages.length) { resetPreview(); notice(''); } return; }
      paginate();
    }, 350);
  }
  e.story.addEventListener('input', () => { trackSource(sourceLines()); updateCount(); schedule(); queueDraft(); });
  e.storyTitle.addEventListener('input', () => { schedule(); queueDraft(); });
  function loadWatermark(file, name, save = true) {
    const version = ++uploadVersion;
    const url = URL.createObjectURL(file);
    const image = new Image();
    e.watermarkStatus.textContent = '正在載入圖片…';
    return new Promise((resolve, reject) => {
      image.onload = () => {
      if (version !== uploadVersion) { URL.revokeObjectURL(url); resolve(false); return; }
      if (watermarkUrl) URL.revokeObjectURL(watermarkUrl);
      watermarkImage = image;
      watermarkUrl = url;
      watermarkName = name;
      e.watermarkThumb.src = url;
      e.watermarkThumb.style.opacity = String(watermarkAlpha());
      e.watermarkThumb.hidden = false;
      e.watermarkStatus.textContent = watermarkName;
      e.removeWatermark.hidden = false;
      e.watermarkOpacity.disabled = false;
      e.watermarkSize.disabled = false;
      if (save) {
        draftWrite = draftWrite.catch(() => {}).then(() => draftRequest('readwrite', store => store.put({ blob: file, name }, 'watermark'), 'assets'));
        draftWrite.catch(() => { e.draftStatus.textContent = '浮水印暫存失敗，請確認裝置剩餘空間'; });
        queueDraft();
        if (pages.length) { e.exportPreview.open = true; paginate(); }
        else notice('浮水印圖片已載入。');
      }
      resolve(true);
      };
      image.onerror = () => {
      URL.revokeObjectURL(url);
      if (version !== uploadVersion) { resolve(false); return; }
      e.watermarkStatus.textContent = watermarkName || '尚未選擇圖片';
      e.watermarkFile.value = '';
      reject(Error('這張圖片無法讀取，請換一張 PNG、JPG 或 WebP 圖片。'));
      };
      image.src = url;
    });
  }
  e.watermarkFile.addEventListener('change', () => {
    const file = e.watermarkFile.files?.[0];
    if (!file) return;
    if (file.type && !['image/png','image/jpeg','image/webp','image/heic','image/heif'].includes(file.type)) {
      notice('請選擇 PNG、JPG、WebP 或 HEIC 圖片。', true);
      e.watermarkFile.value = '';
      return;
    }
    loadWatermark(file, file.name).catch(error => notice(error.message, true));
  });
  function removeWatermark(save = true) {
    uploadVersion++;
    if (watermarkUrl) URL.revokeObjectURL(watermarkUrl);
    watermarkUrl = '';
    watermarkImage = null;
    watermarkName = '';
    e.watermarkFile.value = '';
    e.watermarkThumb.removeAttribute('src');
    e.watermarkThumb.hidden = true;
    e.watermarkStatus.textContent = '尚未選擇圖片';
    e.removeWatermark.hidden = true;
    e.watermarkOpacity.disabled = true;
    e.watermarkSize.disabled = true;
    if (save) {
      draftWrite = draftWrite.catch(() => {}).then(() => draftRequest('readwrite', store => store.delete('watermark'), 'assets'));
      queueDraft();
      if (pages.length) paginate();
      else notice('已移除浮水印。');
    }
  }
  e.removeWatermark.onclick = () => removeWatermark();
  function updateWatermarkSettings(immediate = false) {
    e.watermarkOpacityValue.textContent = e.watermarkOpacity.value + '%';
    e.watermarkSizeValue.textContent = e.watermarkSize.value + '%';
    e.watermarkThumb.style.opacity = String(watermarkAlpha());
    readyFiles = null;
    readyAlpha = null;
    readySize = null;
    renderVersion++;
    e.downloadAll.disabled = true;
    refreshExportPreview();
    if (!pages.length) return;
    if (immediate) prepareFiles();
    else schedulePrepare(250);
  }
  for (const id of ['watermarkOpacity','watermarkSize']) {
    e[id].addEventListener('input', () => { updateWatermarkSettings(); queueDraft(); });
    e[id].addEventListener('change', () => { updateWatermarkSettings(true); queueDraft(); });
  }
  for (const id of ['width','height','fontSize','padding','font','bg','ink','light','lineHeight','indent','fixedHeight']) {
    e[id].addEventListener(['font','indent','fixedHeight'].includes(id) ? 'change' : 'input', () => {
      syncOutputs();
      if (['width','height','fontSize','font','padding','lineHeight','indent','fixedHeight'].includes(id)) { cuts = []; cutsReady = false; }
      schedule();
      queueDraft();
    });
  }
  e.sizePresets.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    e.width.value = button.dataset.w; e.height.value = button.dataset.h;
    cuts = []; cutsReady = false;
    syncOutputs(); schedule(); queueDraft();
  });
  for (const button of e.themes.children) {
    const swatch = document.createElement('i');
    swatch.style.background = `linear-gradient(135deg, ${button.dataset.bg} 55%, ${button.dataset.ink} 55% 78%, ${button.dataset.light} 78%)`;
    button.prepend(swatch);
  }
  e.themes.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    e.bg.value = button.dataset.bg; e.ink.value = button.dataset.ink; e.light.value = button.dataset.light;
    e.cardFrame.style.background = button.dataset.bg;
    syncOutputs(); schedule(); queueDraft();
  });
  const blobOf = target => new Promise(resolve => target.toBlob(resolve, 'image/png'));
  let prepareTimer;
  function schedulePrepare(delay = 600) {
    clearTimeout(prepareTimer);
    renderVersion++;
    readyFiles = null; readyAlpha = null; readySize = null;
    e.downloadAll.disabled = true;
    prepareTimer = setTimeout(prepareFiles, delay);
  }
  async function prepareFiles() {
    clearTimeout(prepareTimer);
    const version = ++renderVersion;
    const alpha = watermarkAlpha();
    const sizeFactor = watermarkSizeFactor();
    const image = watermarkImage;
    readyFiles = null;
    readyAlpha = null;
    readySize = null;
    e.downloadAll.disabled = true;
    const output = document.createElement('canvas'), files = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        paint(output, i, alpha, sizeFactor);
        const blob = await blobOf(output);
        if (!blob) throw Error('圖片產生失敗');
        files.push(new File([blob], filename(i), { type: 'image/png' }));
      }
      if (version === renderVersion && image === watermarkImage && alpha === watermarkAlpha() && sizeFactor === watermarkSizeFactor()) {
        readyFiles = files;
        readyAlpha = alpha;
        readySize = sizeFactor;
        readyImage = image;
        e.downloadAll.disabled = false;
      }
    } catch (error) { if (version === renderVersion) notice('整理圖片失敗：' + error.message, true); }
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const filename = index => '敘事圖卡_' + String(index + 1).padStart(2, '0') + '.png';
  e.downloadPage.onclick = async () => {
    const output = document.createElement('canvas');
    paint(output, current);
    const blob = await blobOf(output);
    if (blob) { saveBlob(blob, filename(current)); notice('已下載目前這張圖卡。'); }
  };
  e.share.onclick = async () => {
    const output = document.createElement('canvas');
    paint(output, current);
    const blob = await blobOf(output);
    if (!blob) return;
    const file = new File([blob], filename(current), { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '敘事圖卡' }); return; }
      catch (error) { if (error.name === 'AbortError') return; }
    }
    saveBlob(blob, filename(current));
    notice('此瀏覽器未提供圖片分享，已下載 PNG。');
  };
  const crcTable = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, check = crc(data);
      const local = new Uint8Array(30 + name.length), v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
      v.setUint32(14, check, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true); local.set(name, 30); parts.push(local, data);
      const item = new Uint8Array(46 + name.length), cv = new DataView(item.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x800, true); cv.setUint32(16, check, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      item.set(name, 46); central.push(item); offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true);
    v.setUint16(10, files.length, true); v.setUint32(12, centralSize, true);
    v.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  e.downloadAll.onclick = () => {
    const files = readyFiles;
    if (!files || readyAlpha !== watermarkAlpha() || readySize !== watermarkSizeFactor() || readyImage !== watermarkImage) {
      if (pages.length) { prepareFiles(); notice('正在整理圖片，完成後請再按一次「儲存全部圖片」。'); }
      return;
    }
    if (navigator.canShare?.({ files })) {
      try {
        // Call share directly from the tap; awaiting image creation first loses user activation on iPhone.
        navigator.share({ files }).then(() => notice('已開啟所有圖片的分享選單。'), error => {
          if (error.name !== 'AbortError') notice('分享未完成，請再試一次。', true);
        });
        return;
      } catch (error) { /* Fall back to a ZIP below. */ }
    }
    downloadZip(files);
  };
  async function downloadZip(files) {
    e.downloadAll.disabled = true;
    notice('正在整理所有圖卡…');
    try {
      const entries = await Promise.all(files.map(async file => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
      saveBlob(zip(entries), '敘事圖卡_全部.zip');
      notice('此瀏覽器不支援一次分享多張圖片，已下載 ZIP。');
    } catch (error) {
      notice('下載失敗：' + error.message, true);
    } finally {
      e.downloadAll.disabled = !readyFiles;
    }
  }
  function resetPreview() {
    renderVersion++;
    clearTimeout(prepareTimer);
    pages = []; ops = []; safeCuts = []; cuts = []; cutsReady = false;
    totalHeight = 0; current = 0; sourceKey = ''; readyFiles = null;
    readyAlpha = null; readySize = null; readyImage = null; drag = null; cutMode = '';
    previewExtras.forEach(extra => extra.remove());
    previewExtras = [];
    e.pageCanvas.hidden = true;
    e.emptyPreview.hidden = false;
    e.cutLayer.replaceChildren();
    e.cutLayer.hidden = true;
    e.cardFrame.classList.remove('adding-cut');
    e.addCut.classList.remove('active');
    e.removeCut.classList.remove('active');
    e.exportCanvas.hidden = true;
    e.exportPreview.open = false;
    e.resultCount.textContent = '尚未產生';
    e.pageLabel.textContent = '—';
    for (const id of ['prev','next','addCut','removeCut','resetCuts','share','downloadPage','downloadAll']) e[id].disabled = true;
  }
  e.clearDraft.onclick = () => {
    if (!confirm('要清除目前的故事、設定和浮水印嗎？這項操作無法復原。')) return;
    draftEpoch++;
    draftTouched = true;
    clearTimeout(draftTimer);
    clearTimeout(timer);
    for (const id of draftFields) setValue(id, draftDefaults[id]);
    syncOutputs(); updateCount();
    e.cardFrame.style.background = '';
    removeWatermark(false);
    resetPreview();
    notice('已清除暫存與目前的編輯內容。');
    e.draftStatus.textContent = '正在清除暫存…';
    const epoch = draftEpoch;
    draftWrite = draftWrite.catch(() => {}).then(async () => {
      await draftRequest('readwrite', store => store.delete('current'));
      await draftRequest('readwrite', store => store.delete('watermark'), 'assets');
    });
    draftWrite.then(() => { if (epoch === draftEpoch) e.draftStatus.textContent = '暫存已清除'; }, () => {
      if (epoch === draftEpoch) e.draftStatus.textContent = '無法清除裝置暫存，請再試一次';
    });
  };
  async function restoreDraft() {
    e.clearDraft.disabled = true;
    try {
      const [saved, asset] = await Promise.all([
        draftRequest('readonly', store => store.get('current')),
        draftRequest('readonly', store => store.get('watermark'), 'assets')
      ]);
      if ((!saved && !asset) || draftTouched) return;
      for (const id of draftFields) {
        if (typeof saved?.values?.[id] === 'string') setValue(id, saved.values[id]);
      }
      syncOutputs(); updateCount();
      e.cardFrame.style.background = e.bg.value;
      trackSource(sourceLines());
      cuts = Array.isArray(saved?.cuts) ? saved.cuts.filter(Number.isFinite) : [];
      cutsReady = Boolean(saved?.cutsReady);
      current = Number.isInteger(saved?.current) ? Math.max(0, saved.current) : 0;
      if (asset?.blob instanceof Blob) {
        try { await loadWatermark(asset.blob, asset.name || '浮水印圖片', false); }
        catch (error) { e.draftStatus.textContent = '浮水印無法還原，其他內容已恢復'; }
      }
      if (e.story.value.trim()) paginate();
      if (!draftTouched && !e.draftStatus.textContent.includes('無法還原')) e.draftStatus.textContent = '已還原此裝置的暫存內容';
    } catch (error) {
      e.draftStatus.textContent = '無法使用裝置暫存';
    } finally {
      e.clearDraft.disabled = false;
    }
  }
  syncOutputs();
  restoreDraft();
})();
