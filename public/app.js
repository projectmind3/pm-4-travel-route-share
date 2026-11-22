(function () {
  'use strict';

  var app = document.getElementById('app');
  var MAX_BYTES = 3 * 1024 * 1024;
  var KEYS_STORE = 'tripEditKeys';
  var AUTHOR_STORE = 'tripAuthorName';

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function money(n) {
    n = Number(n) || 0;
    return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2800);
  }

  function getKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORE)) || {}; } catch (e) { return {}; }
  }
  function saveKey(id, key) {
    var k = getKeys();
    k[id] = key;
    try { localStorage.setItem(KEYS_STORE, JSON.stringify(k)); } catch (e) { /* ignore */ }
  }
  function removeKey(id) {
    var k = getKeys();
    delete k[id];
    try { localStorage.setItem(KEYS_STORE, JSON.stringify(k)); } catch (e) { /* ignore */ }
  }
  function getAuthor() {
    try { return localStorage.getItem(AUTHOR_STORE) || ''; } catch (e) { return ''; }
  }
  function setAuthor(name) {
    try { localStorage.setItem(AUTHOR_STORE, name); } catch (e) { /* ignore */ }
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          throw new Error((data && data.error) || '请求失败（' + res.status + '）');
        }
        return data;
      });
    }, function () {
      throw new Error('网络好像开小差了，请检查网络后再试');
    });
  }

  function stateBox(icon, msg, extra) {
    return h('div', { class: 'state' }, h('span', { class: 'big', text: icon }), h('p', { text: msg }), extra || null);
  }
  function loadingBox() {
    return h('div', { class: 'state' }, h('span', { class: 'spinner' }), h('p', { text: '正在翻开手账，请稍等…' }));
  }
  function errorBox(err, retry) {
    return stateBox('🍂', err.message || '出了点小问题', retry ? h('button', { class: 'btn', type: 'button', onclick: retry, text: '重新加载' }) : null);
  }

  // ---------- home ----------
  function renderHome(query) {
    clear(app);
    var q = query || '';
    var page = 1;
    var input = h('input', { type: 'search', placeholder: '搜搜目的地、标题或作者…', value: q, 'aria-label': '搜索行程' });
    var form = h('form', { class: 'search', onsubmit: function (e) {
      e.preventDefault();
      q = input.value.trim();
      page = 1;
      load(true);
    } }, input, h('button', { class: 'btn primary', type: 'submit', text: '搜索' }));
    var grid = h('div', { class: 'grid' });
    var status = h('div');
    var moreWrap = h('div', { class: 'more' });
    app.appendChild(h('h2', { text: '大家的旅途' }));
    app.appendChild(form);
    app.appendChild(grid);
    app.appendChild(status);
    app.appendChild(moreWrap);
    var token = 0;

    function card(t) {
      var cover = h('div', { class: 'cover' });
      if (t.coverPhotoId) cover.appendChild(h('img', { src: '/api/photos/' + encodeURIComponent(t.coverPhotoId), alt: '', loading: 'lazy' }));
      else cover.textContent = '🧳';
      return h('a', { class: 'card', href: '#/trip/' + encodeURIComponent(t.id) },
        cover,
        h('h3', { text: t.title }),
        h('div', { class: 'meta' },
          h('span', { class: 'tag', text: '📍 ' + t.destination }),
          h('span', { class: 'tag', text: '✍ ' + t.author }),
          h('span', { class: 'tag', text: (t.dayCount || 0) + ' 天' }),
          h('span', { class: 'tag price', text: money(t.budgetTotal) })),
        t.summary ? h('p', { class: 'sum', text: t.summary }) : null);
    }

    function load(reset) {
      var my = ++token;
      clear(moreWrap);
      clear(status);
      if (reset) clear(grid);
      status.appendChild(loadingBox());
      api('/api/trips?q=' + encodeURIComponent(q) + '&page=' + page).then(function (data) {
        if (my !== token) return;
        clear(status);
        var trips = (data && data.trips) || [];
        trips.forEach(function (t) { grid.appendChild(card(t)); });
        if (!grid.firstChild) {
          status.appendChild(stateBox('📭', q ? '没有找到相关的行程，换个关键词试试？' : '还没有人分享行程，来写下第一篇吧！',
            h('a', { class: 'btn primary', href: '#/new', text: '✎ 写行程' })));
        }
        if (data && data.hasMore) {
          moreWrap.appendChild(h('button', { class: 'btn', type: 'button', text: '加载更多', onclick: function () { page++; load(false); } }));
        }
      }, function (err) {
        if (my !== token) return;
        clear(status);
        status.appendChild(errorBox(err, function () { load(false); }));
      });
    }
    load(true);
  }

  // ---------- detail ----------
  function section(title, bodyEl) {
    return h('section', { class: 'paper' }, h('h2', { text: title }), bodyEl);
  }
  function textBlock(s) { return h('div', { class: 'text-block', text: s }); }

  function openLightbox(src) {
    var lb = document.getElementById('lightbox');
    clear(lb);
    lb.appendChild(h('img', { src: src, alt: '放大的照片' }));
    lb.hidden = false;
  }
  function closeLightbox() { document.getElementById('lightbox').hidden = true; }
  document.getElementById('lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLightbox(); });

  function renderDetail(id) {
    clear(app);
    app.appendChild(loadingBox());
    api('/api/trips/' + encodeURIComponent(id)).then(function (t) {
      clear(app);
      var key = getKeys()[t.id];
      var hero = h('section', { class: 'paper hero' },
        h('h1', { text: t.title }),
        h('div', { class: 'meta' },
          h('span', { class: 'tag', text: '📍 ' + t.destination }),
          h('span', { class: 'tag', text: '✍ ' + t.author }),
          h('span', { class: 'tag', text: ((t.days || []).length) + ' 天' }),
          t.createdAt ? h('span', { class: 'tag', text: '🗓 ' + String(t.createdAt).slice(0, 10) }) : null),
        t.summary ? h('p', { class: 'summary', text: t.summary }) : null);
      if (key) {
        hero.appendChild(h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: '#/edit/' + encodeURIComponent(t.id), text: '✎ 编辑' }),
          h('button', { class: 'btn danger', type: 'button', text: '🗑 删除', onclick: function (e) { doDelete(t, key, e.currentTarget); } })));
      }
      app.appendChild(h('a', { href: '#/', text: '← 返回首页' }));
      app.appendChild(hero);

      var days = t.days || [];
      if (days.length) {
        var wrap = h('div');
        days.forEach(function (d, i) {
          var box = h('div', { class: 'day' }, h('h3', {}, h('span', { class: 'day-no', text: '第 ' + (i + 1) + ' 天' }), h('span', { text: d.title || '' })));
          (d.spots || []).forEach(function (s) {
            box.appendChild(h('div', { class: 'spot' }, h('b', { text: s.name }), s.note ? h('div', { class: 'note', text: s.note }) : null));
          });
          wrap.appendChild(box);
        });
        app.appendChild(section('每日行程', wrap));
      }

      var photos = t.photoIds || [];
      if (photos.length) {
        var g = h('div', { class: 'gallery' });
        photos.forEach(function (pid) {
          var src = '/api/photos/' + encodeURIComponent(pid);
          g.appendChild(h('img', { src: src, alt: '旅途照片', loading: 'lazy', onclick: function () { openLightbox(src); } }));
        });
        app.appendChild(section('照片墙', g));
      }

      var budget = t.budget || [];
      if (budget.length) {
        var tb = h('table', { class: 'budget' });
        var total = 0;
        budget.forEach(function (b) {
          total += Number(b.amount) || 0;
          tb.appendChild(h('tr', {}, h('td', { text: b.label }), h('td', { text: money(b.amount) })));
        });
        tb.appendChild(h('tr', { class: 'total' }, h('td', { text: '合计' }), h('td', { text: money(total) })));
        app.appendChild(section('预算花费', tb));
      }
      if (t.transport) app.appendChild(section('交通', textBlock(t.transport)));
      if (t.lodging) app.appendChild(section('住宿', textBlock(t.lodging)));
      if (t.tips) app.appendChild(section('小贴士与心得', textBlock(t.tips)));
    }, function (err) {
      clear(app);
      app.appendChild(errorBox(err, function () { renderDetail(id); }));
      app.appendChild(h('p', { class: 'more' }, h('a', { href: '#/', text: '← 返回首页' })));
    });
  }

  function doDelete(t, key, btn) {
    if (!window.confirm('确定要删除「' + t.title + '」吗？删除后无法恢复哦。')) return;
    btn.disabled = true;
    api('/api/trips/' + encodeURIComponent(t.id), { method: 'DELETE', headers: { 'X-Edit-Key': key } }).then(function () {
      removeKey(t.id);
      toast('已删除');
      location.hash = '#/';
    }, function (err) {
      btn.disabled = false;
      toast(err.message);
    });
  }

  // ---------- image compression ----------
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片')); };
      img.src = url;
    });
  }
  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('图片压缩失败')); }, 'image/jpeg', q);
    });
  }
  function compress(file) {
    return loadImage(file).then(function (img) {
      var w = img.naturalWidth, hgt = img.naturalHeight;
      var scale = Math.min(1, 1600 / w);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(hgt * scale));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      var q = 0.85;
      function attempt() {
        return toBlob(canvas, q).then(function (b) {
          if (b.size < MAX_BYTES) return b;
          if (q > 0.35) { q -= 0.15; return attempt(); }
          // still too large: shrink dimensions
          canvas.width = Math.round(canvas.width * 0.7);
          canvas.height = Math.round(canvas.height * 0.7);
          ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return attempt();
        });
      }
      return attempt();
    });
  }
  function uploadPhoto(file) {
    return compress(file).then(function (blob) {
      return api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    }).then(function (r) { return r.id; });
  }

  // ---------- form ----------
  function renderForm(id) {
    clear(app);
    if (id) {
      if (!getKeys()[id]) {
        app.appendChild(stateBox('🔒', '只有发布者本人（在发布时用的这台设备上）才能编辑这篇行程。',
          h('a', { class: 'btn', href: '#/trip/' + encodeURIComponent(id), text: '← 返回行程' })));
        return;
      }
      app.appendChild(loadingBox());
      api('/api/trips/' + encodeURIComponent(id)).then(function (t) { buildForm(t); }, function (err) {
        clear(app);
        app.appendChild(errorBox(err, function () { renderForm(id); }));
      });
    } else {
      buildForm(null);
    }
  }

  function buildForm(trip) {
    clear(app);
    var editing = !!trip;
    var photoIds = trip ? (trip.photoIds || []).slice() : [];

    var fTitle = h('input', { type: 'text', maxlength: '100', placeholder: '例如：三天两夜漫游京都', value: trip ? trip.title : '' });
    var fDest = h('input', { type: 'text', maxlength: '100', placeholder: '例如：日本 · 京都', value: trip ? trip.destination : '' });
    var fAuthor = h('input', { type: 'text', maxlength: '50', placeholder: '你的名字或昵称', value: trip ? trip.author : getAuthor() });
    var fSummary = h('textarea', { placeholder: '用几句话介绍这次旅行…' });
    fSummary.value = trip ? (trip.summary || '') : '';
    var fTransport = h('textarea', { placeholder: '怎么去、怎么玩：飞机、地铁、打车…' });
    fTransport.value = trip ? (trip.transport || '') : '';
    var fLodging = h('textarea', { placeholder: '住在哪里、体验如何…' });
    fLodging.value = trip ? (trip.lodging || '') : '';
    var fTips = h('textarea', { placeholder: '小贴士、避坑提醒和旅行心得…' });
    fTips.value = trip ? (trip.tips || '') : '';

    function field(label, el) { return h('div', {}, h('label', { text: label }), el); }

    // days
    var daysBox = h('div');
    function addSpot(spotsBox, s) {
      var name = h('input', { type: 'text', placeholder: '景点 / 地点名称', value: s ? s.name : '', 'data-f': 'spot-name' });
      var note = h('textarea', { placeholder: '这里的小记录（选填）', 'data-f': 'spot-note', style: 'min-height:60px' });
      note.value = s ? (s.note || '') : '';
      var row = h('div', { class: 'spotform' }, h('div', { class: 'fields' }, name, note),
        h('button', { class: 'x', type: 'button', 'aria-label': '删除景点', text: '✕', onclick: function () { spotsBox.removeChild(row); } }));
      spotsBox.appendChild(row);
    }
    function addDay(d) {
      var title = h('input', { type: 'text', placeholder: '这一天的主题，例如：古城慢游', value: d ? d.title : '', 'data-f': 'day-title' });
      var spotsBox = h('div');
      var box = h('div', { class: 'dayform' });
      var head = h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'day-label', text: '' }), title),
        h('button', { class: 'x', type: 'button', 'aria-label': '删除这一天', text: '✕', onclick: function () { daysBox.removeChild(box); renumber(); } }));
      box.appendChild(head);
      box.appendChild(spotsBox);
      box.appendChild(h('button', { class: 'btn', type: 'button', text: '＋ 添加景点', onclick: function () { addSpot(spotsBox, null); } }));
      box._spots = spotsBox;
      box._title = title;
      daysBox.appendChild(box);
      renumber();
      if (d && d.spots && d.spots.length) d.spots.forEach(function (s) { addSpot(spotsBox, s); });
      else addSpot(spotsBox, null);
    }
    function renumber() {
      Array.prototype.forEach.call(daysBox.children, function (box, i) {
        box.querySelector('.day-label').textContent = '第 ' + (i + 1) + ' 天';
      });
    }
    if (trip && trip.days && trip.days.length) trip.days.forEach(addDay); else addDay(null);

    // budget
    var budgetBox = h('div');
    function addBudget(b) {
      var label = h('input', { type: 'text', placeholder: '项目，如：机票', value: b ? b.label : '', class: 'grow' });
      var amt = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '金额 ¥', class: 'amt', value: b ? String(b.amount) : '' });
      var row = h('div', { class: 'row budgetrow' }, label, amt,
        h('button', { class: 'x', type: 'button', 'aria-label': '删除这一项', text: '✕', onclick: function () { budgetBox.removeChild(row); } }));
      row._label = label; row._amt = amt;
      budgetBox.appendChild(row);
    }
    if (trip && trip.budget && trip.budget.length) trip.budget.forEach(addBudget); else addBudget(null);

    // photos
    var thumbs = h('div', { class: 'thumbs' });
    function drawThumbs() {
      clear(thumbs);
      photoIds.forEach(function (pid, i) {
        thumbs.appendChild(h('div', { class: 'thumb' },
          h('img', { src: '/api/photos/' + encodeURIComponent(pid), alt: '已上传照片' }),
          h('button', { class: 'x', type: 'button', 'aria-label': '移除照片', text: '✕', onclick: function () { photoIds.splice(i, 1); drawThumbs(); } })));
      });
    }
    drawThumbs();
    var photoMsg = h('p', { class: 'hint', text: '照片会在浏览器里自动压缩（最宽 1600 像素）后上传。' });
    var fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    var pickBtn = h('button', { class: 'btn', type: 'button', text: '📷 选择照片', onclick: function () { fileInput.click(); } });
    var uploading = false;
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      if (!files.length) return;
      uploading = true;
      pickBtn.disabled = true;
      var done = 0, failed = 0;
      function next() {
        if (!files.length) {
          uploading = false;
          pickBtn.disabled = false;
          photoMsg.textContent = failed ? '有 ' + failed + ' 张照片上传失败，请重试。' : '上传完成 ✓';
          return;
        }
        var f = files.shift();
        photoMsg.textContent = '正在处理第 ' + (done + failed + 1) + ' 张照片…';
        uploadPhoto(f).then(function (pid) { photoIds.push(pid); done++; drawThumbs(); }, function (e) {
          failed++; toast(e.message);
        }).then(next);
      }
      next();
    });

    var errBox = h('div');
    var submit = h('button', { class: 'btn primary', type: 'submit', text: editing ? '保存修改' : '发布行程' });

    var form = h('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      clear(errBox);
      function fail(msg) { errBox.appendChild(h('div', { class: 'err', text: msg })); errBox.scrollIntoView({ block: 'center' }); }
      if (uploading) return fail('照片还在上传中，请稍等一下。');
      var title = fTitle.value.trim(), dest = fDest.value.trim(), author = fAuthor.value.trim();
      if (!title) return fail('请填写行程标题。');
      if (!dest) return fail('请填写目的地。');
      if (!author) return fail('请填写作者名称。');
      var days = [];
      Array.prototype.forEach.call(daysBox.children, function (box) {
        var spots = [];
        Array.prototype.forEach.call(box._spots.children, function (sp) {
          var nm = sp.querySelector('[data-f="spot-name"]').value.trim();
          var nt = sp.querySelector('[data-f="spot-note"]').value.trim();
          if (nm) spots.push({ name: nm, note: nt });
        });
        var dt = box._title.value.trim();
        if (dt || spots.length) days.push({ title: dt, spots: spots });
      });
      var budget = [];
      var bad = false;
      Array.prototype.forEach.call(budgetBox.children, function (row) {
        var lb = row._label.value.trim();
        var raw = row._amt.value.trim();
        if (!lb && !raw) return;
        var n = Number(raw);
        if (!lb || raw === '' || !isFinite(n) || n < 0) { bad = true; return; }
        budget.push({ label: lb, amount: n });
      });
      if (bad) return fail('预算每一行都需要填写项目名称和有效金额（或把空行删除）。');
      var body = {
        title: title, destination: dest, author: author,
        summary: fSummary.value.trim(), transport: fTransport.value.trim(),
        lodging: fLodging.value.trim(), tips: fTips.value.trim(),
        days: days, budget: budget, photoIds: photoIds.slice()
      };
      submit.disabled = true;
      var opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      if (editing) opts.headers['X-Edit-Key'] = getKeys()[trip.id];
      api(editing ? '/api/trips/' + encodeURIComponent(trip.id) : '/api/trips', opts).then(function (res) {
        setAuthor(author);
        var tid = editing ? trip.id : res.id;
        if (!editing && res.editKey) saveKey(res.id, res.editKey);
        toast(editing ? '修改已保存 ✓' : '发布成功 ✓');
        location.hash = '#/trip/' + encodeURIComponent(tid);
      }, function (err) {
        submit.disabled = false;
        fail(err.message);
      });
    } },
      h('section', { class: 'paper' }, h('h2', { text: '基本信息' }),
        field('标题', fTitle), field('目的地', fDest), field('作者', fAuthor), field('简介', fSummary)),
      h('section', { class: 'paper' }, h('h2', { text: '每日行程' }), daysBox,
        h('button', { class: 'btn', type: 'button', text: '＋ 添加一天', onclick: function () { addDay(null); } })),
      h('section', { class: 'paper' }, h('h2', { text: '预算花费' }), budgetBox,
        h('button', { class: 'btn', type: 'button', text: '＋ 添加一项', onclick: function () { addBudget(null); } })),
      h('section', { class: 'paper' }, h('h2', { text: '交通与住宿' }), field('交通', fTransport), field('住宿', fLodging)),
      h('section', { class: 'paper' }, h('h2', { text: '小贴士与心得' }), fTips),
      h('section', { class: 'paper' }, h('h2', { text: '照片' }), thumbs, pickBtn, fileInput, photoMsg),
      errBox,
      h('div', { class: 'actions' }, submit,
        h('a', { class: 'btn', href: editing ? '#/trip/' + encodeURIComponent(trip.id) : '#/', text: '取消' })));

    app.appendChild(h('h2', { text: editing ? '编辑行程' : '写一篇新行程' }));
    app.appendChild(form);
  }

  // ---------- router ----------
  function route() {
    closeLightbox();
    var hash = location.hash || '#/';
    var m;
    window.scrollTo(0, 0);
    if ((m = hash.match(/^#\/trip\/([^/?]+)/))) renderDetail(decodeURIComponent(m[1]));
    else if ((m = hash.match(/^#\/edit\/([^/?]+)/))) renderForm(decodeURIComponent(m[1]));
    else if (hash.indexOf('#/new') === 0) renderForm(null);
    else renderHome('');
  }
  window.addEventListener('hashchange', route);
  route();
})();
